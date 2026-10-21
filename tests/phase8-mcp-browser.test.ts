import { describe, expect, it } from 'vitest';
import { McpServerStore } from '@/lib/agent/mcp/store';
import type { KeyValueBackend } from '@/lib/agent/memory/store';
import { PermissionManager } from '@/lib/agent/permission';
import { createToolExecutor } from '@/lib/agent/runtime';
import { browserListTabsTool, createMcpTools } from '@/lib/agent/tools/mcp';
import { ToolRegistry, defaultRegistry } from '@/lib/agent/tools/registry';

function makeStore(): McpServerStore {
  const mem = new Map<string, unknown>();
  const backend: KeyValueBackend = {
    async get(k) {
      return mem.get(k);
    },
    async set(k, v) {
      mem.set(k, v);
    },
  };
  return new McpServerStore(backend);
}

describe('Phase 8 — local MCP server bridge & BROWSER scope capability', () => {
  it('exposes complete Phase 0–8 tool suite (21 tools across all 5 scopes)', () => {
    const allNames = defaultRegistry.list().map((t) => t.name);
    expect(allNames).toEqual([
      'demo_echo',
      'native_echo',
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
      'memory_remember',
      'memory_recall',
      'memory_forget',
      'skill_list',
      'skill_activate',
      'mcp_list_servers',
      'mcp_list_tools',
      'mcp_call_tool',
      'browser_list_tabs',
    ]);
  });

  it('allows only enabled user-registered serverIds and blocks command smuggling', async () => {
    const store = makeStore();
    await store.upsert({
      id: 'local-sqlite',
      name: 'SQLite MCP',
      command: 'mcp-server-sqlite',
      args: ['--db', 'dev.db'],
    });

    const mgr = new PermissionManager({ EXECUTE: 'allow', BROWSER: 'ask' });
    const registry = new ToolRegistry();
    for (const t of createMcpTools(store)) registry.register(t);
    registry.register(browserListTabsTool);

    const nativePayloads: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const exec = createToolExecutor({
      registry,
      policy: mgr.evaluate,
      nativeBridge: {
        async execute(toolName, args) {
          const srv = await store.getEnabled(String(args['serverId'] ?? ''));
          if (!srv) {
            return {
              status: 'error',
              error: { code: 'PERMISSION_DENIED', message: 'server not enabled' },
            };
          }
          const outbound = {
            command: srv.command,
            args: srv.args,
            toolName: args['toolName'],
            arguments: args['arguments'] ?? {},
          };
          nativePayloads.push({ toolName, args: outbound });
          return {
            status: 'ok',
            result: { content: [{ type: 'text', text: 'rows: 3' }] },
            durationMs: 7,
          };
        },
      },
    });

    // Rejects arbitrary `command` field injected by prompt injection (strict schema).
    const smuggled = await exec({
      call: {
        id: 'mcp_bad',
        name: 'mcp_call_tool',
        arguments: {
          serverId: 'local-sqlite',
          toolName: 'read_query',
          command: '/bin/sh',
        },
      },
    });
    expect(smuggled).toMatchObject({
      status: 'error',
      error: { code: 'UNKNOWN_ARGUMENT' },
    });

    // Disabling server immediately prevents execution.
    await store.setEnabled('local-sqlite', false);
    const disabledRes = await exec({
      call: {
        id: 'mcp_disabled',
        name: 'mcp_list_tools',
        arguments: { serverId: 'local-sqlite' },
      },
    });
    expect(disabledRes).toMatchObject({
      status: 'error',
      error: { code: 'PERMISSION_DENIED' },
    });

    // Re-enabling server dispatches cleanly with trusted command + args from store.
    await store.setEnabled('local-sqlite', true);
    const okRes = await exec({
      call: {
        id: 'mcp_ok',
        name: 'mcp_call_tool',
        arguments: {
          serverId: 'local-sqlite',
          toolName: 'read_query',
          arguments: { sql: 'SELECT count(*) FROM users' },
        },
      },
    });
    expect(okRes.status).toBe('ok');
    expect(nativePayloads).toEqual([
      {
        toolName: 'mcp_call_tool',
        args: {
          command: 'mcp-server-sqlite',
          args: ['--db', 'dev.db'],
          toolName: 'read_query',
          arguments: { sql: 'SELECT count(*) FROM users' },
        },
      },
    ]);

    // Browser tool pauses cleanly behind BROWSER scope gate.
    const browserGate = await exec({
      call: { id: 'b_1', name: 'browser_list_tabs', arguments: { activeOnly: true } },
    });
    expect(browserGate).toEqual({
      status: 'permission_required',
      risk: 'browser',
      scope: 'BROWSER',
      toolName: 'browser_list_tabs',
    });
  });
});
