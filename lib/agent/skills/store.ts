/**
 * Phase 7 — Reusable Local Skills Store & Prompt Bootstrapper (100% Offline).
 */

import { defaultMemoryStore, type KeyValueBackend } from '../memory/store';
import { browser } from 'wxt/browser';

export const SKILLS_STORAGE_KEY = 'skills.custom.v1';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'custom';
  playbook: string;
}

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  {
    id: 'code-review',
    name: 'Deep Code Review',
    description: 'Inspect git status/diff and audit security, edge cases & regressions',
    source: 'builtin',
    playbook: [
      '1. Call `git_status` and `git_diff` to inspect modified files and hunks.',
      '2. Read surrounding context with `fs_read_file` whenever invariants cross file boundaries.',
      '3. Report concrete defects ordered by severity with file path, line numbers, and exact fix.',
    ].join('\n'),
  },
  {
    id: 'bug-hunt',
    name: 'Root-Cause Bug Hunt',
    description: 'Search codebase, isolate root cause, apply minimal fix & run test suite',
    source: 'builtin',
    playbook: [
      '1. Search symbols/errors with `fs_search` and read full source context via `fs_read_file`.',
      '2. Verify the failure hypothesis before modifying code; record key findings via `memory_remember`.',
      '3. Apply minimal targeted edits with `fs_write_file` and verify via `shell_exec` test run.',
    ].join('\n'),
  },
  {
    id: 'commit-craft',
    name: 'Atomic Commit Craft',
    description: 'Review working tree changes and create a clean Conventional Commit',
    source: 'builtin',
    playbook: [
      '1. Inspect working tree via `git_status`, `git_diff`, and recent style via `git_log`.',
      '2. Stage intended workspace files explicitly with `git_stage`.',
      '3. Commit with a concise Conventional Commit message via `git_commit`.',
    ].join('\n'),
  },
];

const fallbackCustom = new Map<string, unknown>();

const defaultSkillBackend: KeyValueBackend = {
  async get(key: string): Promise<unknown> {
    try {
      if (browser?.storage?.local) {
        const res = await browser.storage.local.get(key);
        return res[key];
      }
    } catch {
      /* fallback */
    }
    return fallbackCustom.get(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      if (browser?.storage?.local) {
        await browser.storage.local.set({ [key]: value });
        return;
      }
    } catch {
      /* fallback */
    }
    fallbackCustom.set(key, value);
  },
};

export class SkillStore {
  constructor(private readonly backend: KeyValueBackend = defaultSkillBackend) {}

  private async readCustom(): Promise<SkillDefinition[]> {
    const raw = await this.backend.get(SKILLS_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is SkillDefinition =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SkillDefinition).id === 'string' &&
        typeof (item as SkillDefinition).name === 'string' &&
        typeof (item as SkillDefinition).playbook === 'string',
    );
  }

  async list(): Promise<SkillDefinition[]> {
    const custom = await this.readCustom();
    const customIds = new Set(custom.map((s) => s.id));
    return [
      ...BUILTIN_SKILLS.filter((b) => !customIds.has(b.id)),
      ...custom,
    ];
  }

  async get(id: string): Promise<SkillDefinition | undefined> {
    const all = await this.list();
    return all.find((s) => s.id === id);
  }

  async upsertCustom(input: {
    id: string;
    name: string;
    description: string;
    playbook: string;
  }): Promise<SkillDefinition> {
    const id = input.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    if (!id) throw new Error('skill id must contain alphanumeric characters');

    const skill: SkillDefinition = {
      id,
      name: input.name.trim() || id,
      description: input.description.trim(),
      source: 'custom',
      playbook: input.playbook.trim(),
    };

    const existing = (await this.readCustom()).filter((s) => s.id !== id);
    existing.push(skill);
    await this.backend.set(SKILLS_STORAGE_KEY, existing);
    return skill;
  }

  async removeCustom(id: string): Promise<boolean> {
    const existing = await this.readCustom();
    const next = existing.filter((s) => s.id !== id);
    if (next.length === existing.length) return false;
    await this.backend.set(SKILLS_STORAGE_KEY, next);
    return true;
  }
}

export function buildSkillBootstrapPrompt(
  skill: SkillDefinition,
  toolNames: string[],
): string {
  return [
    `[GPT++ Local Skill Activated: ${skill.name} (${skill.id})]`,
    `Available GPT++ tools: ${toolNames.join(', ')}`,
    'Emit tool calls strictly using:',
    '<gptpp:tool_call>{"id":"call_1","name":"TOOL_NAME","arguments":{}}</gptpp:tool_call>',
    '',
    'Skill Playbook:',
    skill.playbook,
  ].join('\n');
}

export const defaultSkillStore = new SkillStore();
void defaultMemoryStore;
