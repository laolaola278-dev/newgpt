import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_SCOPES,
  PermissionManager,
  resolveToolScope,
  summarizeToolArgs,
} from '@/lib/agent/permission';
import { createToolExecutor } from '@/lib/agent/runtime';
import { ToolRegistry } from '@/lib/agent/tools/registry';

describe('Phase 5 — 5-scope permission manager & interactive consent queue', () => {
  it('maps risk tiers and explicit scopes cleanly onto READ/WRITE/EXECUTE/GIT/BROWSER', () => {
    expect(ALL_PERMISSION_SCOPES).toEqual(['READ', 'WRITE', 'EXECUTE', 'GIT', 'BROWSER']);
    expect(resolveToolScope({ risk: 'safe' })).toBeNull();
    expect(resolveToolScope({ risk: 'low' })).toBeNull();
    expect(resolveToolScope({ risk: 'read' })).toBe('READ');
    expect(resolveToolScope({ risk: 'write' })).toBe('WRITE');
    expect(resolveToolScope({ risk: 'execute' })).toBe('EXECUTE');
    expect(resolveToolScope({ risk: 'git' })).toBe('GIT');
    expect(resolveToolScope({ risk: 'browser' })).toBe('BROWSER');
    expect(resolveToolScope({ risk: 'read', scope: 'GIT' })).toBe('GIT');
  });

  it('supports allow_once, allow_session (auto-resolving sibling waiters), and deny revocation', async () => {
    const mgr = new PermissionManager();

    // 1. allow_once resolves current prompt without persisting session grant.
    const oncePromise = mgr.requestApproval({
      callId: 'c1',
      toolName: 'fs_write_file',
      scope: 'WRITE',
      risk: 'write',
      argsSummary: summarizeToolArgs({ path: 'src/a.ts', content: 'export const x = 1;' }),
    });
    const [pending1] = mgr.snapshot().pending;
    expect(pending1?.argsSummary).toBe('path: "src/a.ts", content: "<19 chars>"');
    expect(mgr.resolvePending(pending1!.id, 'allow_once')).toBe(true);
    expect(await oncePromise).toBe(true);
    expect(mgr.evaluate({ name: 'fs_write_file', risk: 'write' })).toBe('ask');

    // 2. allow_session grants scope for the session AND approves concurrent waiters of same scope.
    const w1 = mgr.requestApproval({
      callId: 'c2',
      toolName: 'fs_read_file',
      scope: 'READ',
      risk: 'read',
    });
    const w2 = mgr.requestApproval({
      callId: 'c3',
      toolName: 'fs_search',
      scope: 'READ',
      risk: 'read',
    });
    const firstRead = mgr.snapshot().pending[0]!;
    expect(mgr.resolvePending(firstRead.id, 'allow_session')).toBe(true);
    expect(await Promise.all([w1, w2])).toEqual([true, true]);
    expect(mgr.evaluate({ name: 'fs_read_file', risk: 'read' })).toBe('allow');

    // 3. Switching scope policy to 'deny' revokes active session grant immediately.
    mgr.setScopeDecision('READ', 'deny');
    expect(mgr.evaluate({ name: 'fs_read_file', risk: 'read' })).toBe('deny');
  });

  it('integrates directly with createToolExecutor across custom scopes', async () => {
    const mgr = new PermissionManager({ GIT: 'ask', BROWSER: 'deny' });
    const registry = new ToolRegistry();
    registry.register({
      name: 'git_probe',
      description: 'probe git',
      inputSchema: { type: 'object', properties: {} },
      risk: 'git',
      scope: 'GIT',
      execute: async () => ({ clean: true }),
    });
    registry.register({
      name: 'tab_probe',
      description: 'probe tabs',
      inputSchema: { type: 'object', properties: {} },
      risk: 'browser',
      scope: 'BROWSER',
      execute: async () => ({ tabs: [] }),
    });

    const exec = createToolExecutor({ registry, policy: mgr.evaluate });

    const gitReply = await exec({
      call: { id: 'g1', name: 'git_probe', arguments: {} },
    });
    expect(gitReply).toEqual({
      status: 'permission_required',
      risk: 'git',
      scope: 'GIT',
      toolName: 'git_probe',
    });

    const browserReply = await exec({
      call: { id: 'b1', name: 'tab_probe', arguments: {} },
    });
    expect(browserReply).toMatchObject({
      status: 'error',
      error: { code: 'PERMISSION_DENIED' },
    });
  });
});
