import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultRegistry } from '@/lib/agent/tools/registry';
import { normalizeWorkspaceRoot, resolveWithinWorkspace } from '@/lib/workspace';

describe('Phase 4 — workspace confinement & FS/Shell tool pipeline', () => {
  it('normalizes Unix and Windows workspace roots and rejects relative paths', () => {
    expect(normalizeWorkspaceRoot('/home/dev/project/')).toBe('/home/dev/project');
    expect(normalizeWorkspaceRoot('D:\\work\\repo\\')).toBe('D:/work/repo');
    expect(normalizeWorkspaceRoot('relative/path')).toBeNull();
    expect(normalizeWorkspaceRoot('')).toBeNull();
  });

  it('confines nested paths inside workspace and blocks ../ and prefix escapes', () => {
    const inside = resolveWithinWorkspace('/home/dev/app', 'src/../lib/index.ts');
    expect(inside).toEqual({
      ok: true,
      absolutePath: '/home/dev/app/lib/index.ts',
      relativePath: 'lib/index.ts',
    });

    const traversal = resolveWithinWorkspace('/home/dev/app', '../../etc/passwd');
    expect(traversal.ok).toBe(false);

    const prefixCollision = resolveWithinWorkspace('/home/dev/app', '/home/dev/app-secret/key.pem');
    expect(prefixCollision.ok).toBe(false);
  });

  it('registers all Phase 4 filesystem and shell tools behind permission & schema gates', async () => {
    const names = defaultRegistry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'fs_list_dir',
        'fs_read_file',
        'fs_write_file',
        'fs_search',
        'shell_exec',
      ]),
    );

    const forwarded: Array<{ name: string; args: Record<string, unknown> }> = [];
    const exec = createToolExecutor({
      registry: defaultRegistry,
      nativeBridge: {
        async execute(name, args) {
          forwarded.push({ name, args });
          return { status: 'ok', result: { exitCode: 0, stdout: 'ok' }, durationMs: 4 };
        },
      },
    });

    // Without confirmation, risky tools (read/write/execute) pause for consent.
    const unconfirmed = await exec({
      call: { id: 'sh_1', name: 'shell_exec', arguments: { command: 'pnpm test' } },
    });
    expect(unconfirmed).toEqual({
      status: 'permission_required',
      risk: 'execute',
      toolName: 'shell_exec',
    });
    expect(forwarded).toHaveLength(0);

    // With explicit confirmation, routes cleanly through native bridge.
    const confirmed = await exec({
      call: { id: 'sh_1', name: 'shell_exec', arguments: { command: 'pnpm test' } },
      confirmPermission: true,
    });
    expect(confirmed.status).toBe('ok');
    expect(forwarded).toEqual([{ name: 'shell_exec', args: { command: 'pnpm test' } }]);
  });
});
