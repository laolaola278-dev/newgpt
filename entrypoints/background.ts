/**
 * GPT++ background service worker (MV3).
 *
 * Responsibilities:
 *  - open the Side Panel when the toolbar action is clicked
 *  - log content-script presence announcements from chatgpt.com tabs
 *  - Agent Runtime executor (`tool_execute`): shape → registry → schema →
 *    permission → execution. Native tools route through the capability layer
 *    (Chrome Native Messaging → gptpp-native Rust host); local tools stay in
 *    the worker. Page code never runs capabilities itself.
 */

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isChatGptUrl } from '@/lib/chatgpt-detect';
import { createError, createSuccess, isRequest } from '@/lib/protocol';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultRegistry } from '@/lib/agent/tools/registry';
import type { ExecutorReply, NativeBridge, ToolError } from '@/lib/agent/tools/types';
import { GptppNativeError, type NativeErrorCode } from '@/lib/native/errors';
import { HOST_NAME, NativeMessagingClient } from '@/lib/native/client';
import {
  WORKSPACE_STORAGE_KEY,
  normalizeWorkspaceRoot,
  resolveWithinWorkspace,
} from '@/lib/workspace';

export default defineBackground(() => {
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[GPT++] sidePanel behavior failed', err));

  // ── Native Messaging (capability layer) ──────────────────────────────────
  const nativeClient = new NativeMessagingClient({
    hostName: HOST_NAME,
    portFactory: () => browser.runtime.connectNative(HOST_NAME),
  });

  let lastConnectAttempt = 0;
  async function ensureNativeConnected(force = false): Promise<boolean> {
    if (!force && nativeClient.isConnected()) return true;
    const now = Date.now();
    if (!force && now - lastConnectAttempt < 5000) return nativeClient.isConnected();
    lastConnectAttempt = now;
    try {
      if (force) await nativeClient.reconnect();
      else await nativeClient.connect();
      console.log('[GPT++] native host connected', nativeClient.getCapabilities());
    } catch (err) {
      console.warn('[GPT++] native host unavailable:', (err as Error).message);
    }
    return nativeClient.isConnected();
  }

  function nativeStatusPayload() {
    const caps = nativeClient.getCapabilities();
    return {
      hostName: HOST_NAME,
      state: nativeClient.getState(),
      reason: nativeClient.getLastErrorCode(),
      version: caps?.version ?? null,
      protocolVersion: caps?.protocolVersion ?? null,
      capabilities: caps?.capabilities ?? [],
    };
  }

  function mapNativeError(err: unknown): ToolError {
    if (err instanceof GptppNativeError) {
      const code: NativeErrorCode = err.code;
      if (code === 'TIMEOUT') return { code: 'TIMEOUT', message: err.message };
      if (code === 'NATIVE_HOST_UNAVAILABLE') {
        return { code: 'NATIVE_HOST_UNAVAILABLE', message: err.message };
      }
      return { code: 'TOOL_ERROR', message: `native: ${err.message}` };
    }
    return {
      code: 'TOOL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const WORKSPACE_REQUIRED_TOOLS = new Set([
    'fs_list_dir',
    'fs_read_file',
    'fs_write_file',
    'fs_search',
    'shell_exec',
  ]);

  async function readConfiguredWorkspace(): Promise<string | null> {
    const items = await browser.storage.local.get(WORKSPACE_STORAGE_KEY);
    return normalizeWorkspaceRoot(items[WORKSPACE_STORAGE_KEY]);
  }

  const nativeBridge: NativeBridge = {
    async execute(toolName, args): Promise<ExecutorReply> {
      let outboundArgs: Record<string, unknown> = args;
      if (WORKSPACE_REQUIRED_TOOLS.has(toolName)) {
        const wsRoot = await readConfiguredWorkspace();
        if (!wsRoot) {
          return {
            status: 'error',
            error: {
              code: 'INVALID_ARGUMENTS',
              message:
                'Workspace root is not configured. Open GPT++ Settings to set a valid directory first.',
            },
          };
        }
        const pathArg =
          typeof args['path'] === 'string'
            ? args['path']
            : typeof args['cwd'] === 'string'
              ? args['cwd']
              : '.';
        const confinement = resolveWithinWorkspace(wsRoot, pathArg);
        if (!confinement.ok) {
          return {
            status: 'error',
            error: {
              code: 'PERMISSION_DENIED',
              message: confinement.message,
            },
          };
        }
        outboundArgs = { ...args, workspaceRoot: wsRoot };
      }

      const connected = await ensureNativeConnected();
      if (!connected) {
        return {
          status: 'error',
          error: {
            code: 'NATIVE_HOST_UNAVAILABLE',
            message: 'GPT++ Native Host is unavailable.',
          },
        };
      }
      const startedAt = Date.now();
      try {
        const res = await nativeClient.request(toolName, outboundArgs);
        return {
          status: 'ok',
          result: res.result,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return { status: 'error', error: mapNativeError(err) };
      }
    },
  };

  const executor = createToolExecutor({
    registry: defaultRegistry,
    nativeBridge,
    toolTimeoutMs: 10_000,
  });

  // ── RPC surface ───────────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((message: unknown, _sender): Promise<unknown> | undefined => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'gptpp/hello'
    ) {
      const url = (_sender as { tab?: { url?: string } }).tab?.url;
      if (url && isChatGptUrl(url)) {
        console.log(`[GPT++] content script active on ${url}`);
      }
      return undefined;
    }

    if (!isRequest(message)) return undefined;

    if (message.method === 'tool_execute') {
      return executor(message.params as never)
        .then((reply) => createSuccess(message.id, reply))
        .catch((err: unknown) =>
          createError(
            message.id,
            'RUNTIME_ERROR',
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    if (message.method === 'native_status') {
      return ensureNativeConnected(false).then(() =>
        createSuccess(message.id, nativeStatusPayload()),
      );
    }

    if (message.method === 'native_reconnect') {
      return ensureNativeConnected(true).then(() =>
        createSuccess(message.id, nativeStatusPayload()),
      );
    }

    if (message.method === 'tools_list') {
      return Promise.resolve(
        createSuccess(message.id, { tools: defaultRegistry.list() }),
      );
    }

    // Other methods are handled by their senders (content script).
    return undefined;
  });
});
