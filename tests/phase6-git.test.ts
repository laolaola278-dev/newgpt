import { describe, expect, it } from 'vitest';
import { PermissionManager } from '@/lib/agent/permission';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultRegistry } from '@/lib/agent/tools/registry';

describe('Phase 6 — workspace-confined native Git tools', () => {
  it('registers git_status, git_diff, git_log, git_stage, git_commit under GIT scope', () => {
    const gitEntries = defaultRegistry
      .list()
      .filter((t) => t.name.startsWith('git_'));
    expect(gitEntries.map((t) => t.name)).toEqual([
      'git_status',
      'git_diff',
      'git_log',
      'git_stage',
      'git_commit',
    ]);
    for (const entry of gitEntries) {
      expect(entry.execution).toBe('native');
      expect(entry.scope).toBe('GIT');
    }
  });

  it('enforces array element types on git_stage and gates GIT scope via PermissionManager', async () => {
    const mgr = new PermissionManager({ GIT: 'ask' });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const exec = createToolExecutor({
      registry: defaultRegistry,
      policy: mgr.evaluate,
      nativeBridge: {
        async execute(name, args) {
          calls.push({ name, args });
          return {
            status: 'ok',
            result: { branch: 'main', clean: true, files: [] },
            durationMs: 3,
          };
        },
      },
    });

    // Non-string array element rejected at schema layer before permission prompt.
    const badStage = await exec({
      call: { id: 'g_bad', name: 'git_stage', arguments: { paths: [42 as unknown as string] } },
    });
    expect(badStage).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_ARGUMENTS' },
    });

    // Unconfirmed git_status pauses with explicit GIT scope.
    const gate = await exec({
      call: { id: 'g_1', name: 'git_status', arguments: {} },
    });
    expect(gate).toEqual({
      status: 'permission_required',
      risk: 'git',
      scope: 'GIT',
      toolName: 'git_status',
    });

    // Granting GIT scope allows execution through NativeBridge.
    mgr.setScopeDecision('GIT', 'allow');
    const ok = await exec({
      call: { id: 'g_1', name: 'git_status', arguments: {} },
    });
    expect(ok.status).toBe('ok');
    expect(calls).toEqual([{ name: 'git_status', args: {} }]);
  });
});
