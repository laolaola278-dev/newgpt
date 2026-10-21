import { describe, expect, it } from 'vitest';
import { ProjectMemoryStore, type KeyValueBackend } from '@/lib/agent/memory/store';
import {
  SkillStore,
  buildSkillBootstrapPrompt,
} from '@/lib/agent/skills/store';
import { createToolExecutor } from '@/lib/agent/runtime';
import { createMemoryTools, createSkillTools } from '@/lib/agent/tools/memory';
import { ToolRegistry } from '@/lib/agent/tools/registry';
import { WORKSPACE_STORAGE_KEY } from '@/lib/workspace';

function createMemoryBackend(initialWorkspace = '/home/dev/repo-a'): KeyValueBackend & {
  setWorkspace(ws: string): Promise<void>;
} {
  const map = new Map<string, unknown>([[WORKSPACE_STORAGE_KEY, initialWorkspace]]);
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async setWorkspace(ws: string) {
      map.set(WORKSPACE_STORAGE_KEY, ws);
    },
  };
}

describe('Phase 7 — on-device project memory & reusable local skills', () => {
  it('partitions memories strictly by workspace and supports remember/recall/forget via ToolExecutor', async () => {
    const backend = createMemoryBackend('/home/dev/repo-a');
    const memStore = new ProjectMemoryStore(backend);
    const skillStore = new SkillStore(backend);

    const registry = new ToolRegistry();
    for (const t of [...createMemoryTools(memStore), ...createSkillTools(skillStore)]) {
      registry.register(t);
    }
    const exec = createToolExecutor({ registry });

    await exec({
      call: {
        id: 'm1',
        name: 'memory_remember',
        arguments: {
          key: 'pkg-manager',
          fact: 'Always run pnpm test (never npm)',
          tags: ['tooling', 'ci'],
        },
      },
    });

    const recallA = await exec({
      call: { id: 'm2', name: 'memory_recall', arguments: { query: 'pnpm' } },
    });
    expect(recallA).toMatchObject({
      status: 'ok',
      result: { count: 1, entries: [{ key: 'pkg-manager' }] },
    });

    // Switching workspace isolates memory cleanly.
    await backend.setWorkspace('/home/dev/repo-b');
    const recallB = await exec({
      call: { id: 'm3', name: 'memory_recall', arguments: {} },
    });
    expect(recallB).toMatchObject({
      status: 'ok',
      result: { count: 0, entries: [] },
    });

    // Forget removes entry from repo-a.
    await backend.setWorkspace('/home/dev/repo-a');
    const forgotten = await exec({
      call: { id: 'm4', name: 'memory_forget', arguments: { key: 'pkg-manager' } },
    });
    expect(forgotten).toMatchObject({
      status: 'ok',
      result: { removed: true, key: 'pkg-manager' },
    });
  });

  it('lists built-in + custom skills and generates valid protocol bootstrap prompts', async () => {
    const backend = createMemoryBackend();
    const skillStore = new SkillStore(backend);

    await skillStore.upsertCustom({
      id: 'perf-audit',
      name: 'Performance Audit',
      description: 'Profile hot paths',
      playbook: '1. Search allocations.\n2. Benchmark.',
    });

    const registry = new ToolRegistry();
    for (const t of createSkillTools(skillStore)) {
      registry.register(t);
    }
    const exec = createToolExecutor({ registry });

    const listed = await exec({
      call: { id: 's1', name: 'skill_list', arguments: {} },
    });
    expect(listed.status).toBe('ok');
    const skills = (listed as { status: 'ok'; result: { skills: Array<{ id: string }> } }).result
      .skills;
    expect(skills.map((s) => s.id)).toEqual([
      'code-review',
      'bug-hunt',
      'commit-craft',
      'perf-audit',
    ]);

    const activated = await exec({
      call: { id: 's2', name: 'skill_activate', arguments: { id: 'perf-audit' } },
    });
    expect(activated).toMatchObject({
      status: 'ok',
      result: { id: 'perf-audit', source: 'custom' },
    });

    const fullSkill = (await skillStore.get('code-review'))!;
    const prompt = buildSkillBootstrapPrompt(fullSkill, ['git_status', 'git_diff']);
    expect(prompt).toContain('<gptpp:tool_call>');
    expect(prompt).toContain('git_status, git_diff');
  });
});
