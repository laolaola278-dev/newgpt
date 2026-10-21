/**
 * GPT++ background service worker (MV3).
 *
 * Responsibilities:
 *  - open the Side Panel when the toolbar action is clicked
 *  - maintain 5-scope permission policies, session grants & interactive consent
 *  - Agent Runtime executor (`tool_execute`): shape → registry → schema →
 *    permission → execution. Native tools route through Chrome Native Messaging
 *    to `gptpp-native` with workspace confinement verified on both sides.
 */

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isChatGptUrl } from '@/lib/chatgpt-detect';
import { createError, createSuccess, isRequest } from '@/lib/protocol';
import { createToolExecutor } from '@/lib/agent/runtime';
import {
  PERMISSION_STORAGE_KEY,
  PermissionManager,
  resolveToolScope,
  type ConsentResolution,
  type PermissionDecision,
  type ScopePolicyMap,
} from '@/lib/agent/permission';
import { defaultRegistry } from '@/lib/agent/tools/registry';
import { defaultMcpServerStore } from '@/lib/agent/mcp/store';
import { defaultMemoryStore } from '@/lib/agent/memory/store';
import {
  buildSkillBootstrapPrompt,
  defaultSkillStore,
} from '@/lib/agent/skills/store';
import type {
  ExecutorReply,
  NativeBridge,
  PermissionScope,
  ToolError,
  ToolRisk,
} from '@/lib/agent/tools/types';
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

  // ── 5-Scope Permission Manager ───────────────────────────────────────────
  const permissionManager = new PermissionManager();

  void browser.storage.local
    .get(PERMISSION_STORAGE_KEY)
    .then((items) => {
      const saved = items[PERMISSION_STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        permissionManager.replacePolicy(saved as Partial<ScopePolicyMap>);
      }
    })
    .catch(() => {});

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
    'git_status',
    'git_diff',
    'git_log',
    'git_stage',
    'git_commit',
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
        const candidatePaths: string[] = [];
        if (typeof args['path'] === 'string') candidatePaths.push(args['path']);
        if (typeof args['cwd'] === 'string') candidatePaths.push(args['cwd']);
        if (Array.isArray(args['paths'])) {
          for (const entry of args['paths']) {
            if (typeof entry === 'string') candidatePaths.push(entry);
          }
        }
        if (candidatePaths.length === 0) candidatePaths.push('.');
        for (const p of candidatePaths) {
          const confinement = resolveWithinWorkspace(wsRoot, p);
          if (!confinement.ok) {
            return {
              status: 'error',
              error: {
                code: 'PERMISSION_DENIED',
                message: confinement.message,
              },
            };
          }
        }
        outboundArgs = { ...args, workspaceRoot: wsRoot };
      } else if (toolName === 'mcp_list_tools' || toolName === 'mcp_call_tool') {
        const serverId = typeof args['serverId'] === 'string' ? args['serverId'] : '';
        const server = await defaultMcpServerStore.getEnabled(serverId);
        if (!server) {
          return {
            status: 'error',
            error: {
              code: 'PERMISSION_DENIED',
              message: `MCP server "${serverId}" is not configured or disabled in GPT++ Settings.`,
            },
          };
        }
        const wsRoot = await readConfiguredWorkspace();
        outboundArgs = {
          command: server.command,
          args: server.args,
          ...(wsRoot ? { workspaceRoot: wsRoot } : {}),
          ...(toolName === 'mcp_call_tool'
            ? {
                toolName: args['toolName'],
                arguments: args['arguments'] ?? {},
              }
            : {}),
        };
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
    policy: permissionManager.evaluate,
    nativeBridge,
    toolTimeoutMs: 20_000,
  });

  // ── RPC surface ───────────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener(
    (message: unknown, _sender): Promise<unknown> | undefined => {
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

      if (message.method === 'permission_ask') {
        const p = (message.params ?? {}) as {
          callId?: string;
          toolName?: string;
          risk?: ToolRisk;
          scope?: PermissionScope;
          argsSummary?: string;
        };
        const resolvedScope =
          p.scope ?? resolveToolScope({ risk: p.risk ?? 'execute' }) ?? 'EXECUTE';
        return permissionManager
          .requestApproval({
            callId: p.callId ?? 'unknown',
            toolName: p.toolName ?? 'unknown',
            scope: resolvedScope,
            risk: p.risk ?? 'execute',
            argsSummary: p.argsSummary,
          })
          .then((granted) => createSuccess(message.id, { granted }));
      }

      if (message.method === 'permission_resolve') {
        const p = (message.params ?? {}) as {
          id?: string;
          resolution?: ConsentResolution;
        };
        const ok =
          typeof p.id === 'string' && p.resolution
            ? permissionManager.resolvePending(p.id, p.resolution)
            : false;
        return Promise.resolve(
          createSuccess(message.id, { ok, state: permissionManager.snapshot() }),
        );
      }

      if (message.method === 'permission_cancel_call') {
        const p = (message.params ?? {}) as { callId?: string };
        if (p.callId) permissionManager.cancelByCallId(p.callId);
        return Promise.resolve(createSuccess(message.id, { ok: true }));
      }

      if (message.method === 'permissions_state') {
        return Promise.resolve(
          createSuccess(message.id, permissionManager.snapshot()),
        );
      }

      if (message.method === 'permissions_set_scope') {
        const p = (message.params ?? {}) as {
          scope?: PermissionScope;
          decision?: PermissionDecision;
        };
        if (p.scope && p.decision) {
          const updated = permissionManager.setScopeDecision(p.scope, p.decision);
          return browser.storage.local
            .set({ [PERMISSION_STORAGE_KEY]: updated })
            .then(() =>
              createSuccess(message.id, permissionManager.snapshot()),
            );
        }
        return Promise.resolve(
          createError(message.id, 'INVALID_PARAMS', 'scope and decision required'),
        );
      }

      if (message.method === 'permissions_reset_session') {
        permissionManager.resetSessionGrants();
        return Promise.resolve(
          createSuccess(message.id, permissionManager.snapshot()),
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

      if (message.method === 'skills_state') {
        return Promise.all([
          defaultSkillStore.list(),
          defaultMemoryStore.recall({ limit: 50 }),
        ]).then(([skills, memories]) =>
          createSuccess(message.id, {
            skills,
            memoryCount: memories.length,
            recentMemories: memories.slice(0, 5),
          }),
        );
      }

      if (message.method === 'skill_build_prompt') {
        const p = (message.params ?? {}) as { id?: string };
        return defaultSkillStore.get(p.id ?? '').then((skill) => {
          if (!skill) {
            return createError(message.id, 'NOT_FOUND', `Unknown skill: ${p.id ?? ''}`);
          }
          const prompt = buildSkillBootstrapPrompt(
            skill,
            defaultRegistry.list().map((t) => t.name),
          );
          return createSuccess(message.id, { prompt, skill });
        });
      }

      if (message.method === 'mcp_servers_list') {
        return defaultMcpServerStore
          .list()
          .then((servers) => createSuccess(message.id, { servers }));
      }

      if (message.method === 'mcp_servers_upsert') {
        const p = (message.params ?? {}) as {
          id?: string;
          name?: string;
          command?: string;
          args?: string[];
        };
        return defaultMcpServerStore
          .upsert({
            id: p.id ?? '',
            name: p.name,
            command: p.command ?? '',
            args: p.args,
          })
          .then(() => defaultMcpServerStore.list())
          .then((servers) => createSuccess(message.id, { servers }))
          .catch((err: unknown) =>
            createError(
              message.id,
              'INVALID_PARAMS',
              err instanceof Error ? err.message : String(err),
            ),
          );
      }

      if (message.method === 'mcp_servers_toggle') {
        const p = (message.params ?? {}) as { id?: string; enabled?: boolean };
        return defaultMcpServerStore
          .setEnabled(p.id ?? '', Boolean(p.enabled))
          .then((servers) => createSuccess(message.id, { servers }));
      }

      if (message.method === 'mcp_servers_remove') {
        const p = (message.params ?? {}) as { id?: string };
        return defaultMcpServerStore
          .remove(p.id ?? '')
          .then((servers) => createSuccess(message.id, { servers }));
      }

      return undefined;
    },
  );
});
