/**
 * Runtime executor — the routing pipeline every tool call passes through:
 *
 *   registry lookup → schema validation → permission handshake → execute
 *
 * This module runs inside the background service worker in production and
 * directly in unit tests. It never sees DOM and never evaluates page text.
 */

import { validateArgumentsAgainstSchema } from './tool-call/validator';
import {
  defaultAskResolver,
  defaultPermissionPolicy,
  type AskResolver,
  type PermissionDecision,
  type PermissionPolicy,
} from './permission';
import type {
  ExecutorReply,
  NativeBridge,
  ToolExecutePayload,
  ToolOutcome,
} from './tools/types';
import type { ToolRegistry } from './tools/registry';

export interface RuntimeConfig {
  registry: ToolRegistry;
  policy?: PermissionPolicy;
  resolveAsk?: AskResolver;
  /** Hard cap for a single local execution (ms). */
  toolTimeoutMs?: number;
  /** Capability layer for execution:'native' tools (Native Messaging). */
  nativeBridge?: NativeBridge;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    p.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      },
    );
  });
}

export type ToolExecutor = (payload: ToolExecutePayload) => Promise<ExecutorReply>;

export function createToolExecutor(config: RuntimeConfig): ToolExecutor {
  const policy = config.policy ?? defaultPermissionPolicy;
  const resolveAsk = config.resolveAsk ?? defaultAskResolver;
  const timeoutMs = config.toolTimeoutMs ?? 10_000;

  return async (payload): Promise<ExecutorReply> => {
    const { call } = payload;

    const tool = config.registry.get(call.name);
    if (!tool) {
      return {
        status: 'error',
        error: { code: 'UNKNOWN_TOOL', message: `Unknown GPT++ tool: ${call.name}` },
      };
    }

    const schemaCheck = validateArgumentsAgainstSchema(call.arguments, tool.inputSchema);
    if (!schemaCheck.ok) {
      return {
        status: 'error',
        error: {
          code:
            schemaCheck.code === 'UNKNOWN_ARGUMENT'
              ? 'UNKNOWN_ARGUMENT'
              : 'INVALID_ARGUMENTS',
          message: schemaCheck.message,
        },
      };
    }

    // Second round-trip after consent: re-derive decision honoring confirm.
    const decision: PermissionDecision =
      payload.confirmPermission && policy(tool) === 'ask' ? 'allow' : policy(tool);

    if (decision === 'deny') {
      return {
        status: 'error',
        error: { code: 'PERMISSION_DENIED', message: `Tool "${call.name}" was denied by policy` },
      };
    }

    if (decision === 'ask') {
      return {
        status: 'permission_required',
        risk: tool.risk,
        toolName: tool.name,
      };
    }

    const startedAt = Date.now();

    // Native tools bypass the local executor entirely — the capability
    // layer (Native Messaging client) owns transport and its own timeouts.
    if (tool.execution === 'native') {
      if (!config.nativeBridge) {
        return {
          status: 'error',
          error: {
            code: 'NATIVE_HOST_UNAVAILABLE',
            message: 'GPT++ Native Host is unavailable.',
          },
        };
      }
      return config.nativeBridge.execute(tool.name, call.arguments);
    }

    const outcome: ToolOutcome = await withTimeout<ToolOutcome>(
      (async () => {
        try {
          const result = await tool.execute(call.arguments);
          return { status: 'ok', result, durationMs: Date.now() - startedAt };
        } catch (err) {
          return {
            status: 'error',
            error: {
              code: 'TOOL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          } satisfies ToolOutcome;
        }
      })(),
      timeoutMs,
      () => ({ status: 'error', error: { code: 'TIMEOUT', message: `tool exceeded ${timeoutMs}ms` } }),
    );

    return outcome.status === 'ok'
      ? { status: 'ok', result: outcome.result, durationMs: outcome.durationMs }
      : { status: 'error', error: outcome.error };
  };
}
