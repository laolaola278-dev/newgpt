/**
 * Phase 7 — Pure Local On-Device Project Memory Store (Zero Cloud Dependency).
 *
 * Persists concise architectural facts, conventions, and decisions per workspace
 * inside local extension storage (`chrome.storage.local`), falling back to an
 * isolated in-process map when executed outside a browser runtime (e.g. Vitest).
 */

import { browser } from 'wxt/browser';
import { WORKSPACE_STORAGE_KEY, normalizeWorkspaceRoot } from '@/lib/workspace';

export const MEMORY_STORAGE_KEY = 'memory.entries.v1';
const MAX_ENTRIES_PER_WORKSPACE = 200;
const MAX_FACT_LENGTH = 2048;

export interface MemoryEntry {
  key: string;
  fact: string;
  tags: string[];
  updatedAt: number;
}

export type WorkspaceMemoryBuckets = Record<string, MemoryEntry[]>;

export interface KeyValueBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const fallbackMap = new Map<string, unknown>();

const defaultBackend: KeyValueBackend = {
  async get(key: string): Promise<unknown> {
    try {
      if (browser?.storage?.local) {
        const res = await browser.storage.local.get(key);
        return res[key];
      }
    } catch {
      /* non-extension test environment */
    }
    return fallbackMap.get(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      if (browser?.storage?.local) {
        await browser.storage.local.set({ [key]: value });
        return;
      }
    } catch {
      /* non-extension test environment */
    }
    fallbackMap.set(key, value);
  },
};

export class ProjectMemoryStore {
  constructor(private readonly backend: KeyValueBackend = defaultBackend) {}

  private async resolveBucketKey(explicitWorkspace?: string): Promise<string> {
    if (explicitWorkspace) {
      return normalizeWorkspaceRoot(explicitWorkspace) ?? explicitWorkspace;
    }
    const raw = await this.backend.get(WORKSPACE_STORAGE_KEY);
    return normalizeWorkspaceRoot(raw) ?? '__global__';
  }

  private async readAll(): Promise<WorkspaceMemoryBuckets> {
    const raw = await this.backend.get(MEMORY_STORAGE_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as WorkspaceMemoryBuckets;
    }
    return {};
  }

  async remember(input: {
    key: string;
    fact: string;
    tags?: string[];
    workspace?: string;
  }): Promise<MemoryEntry> {
    const cleanKey = input.key.trim();
    if (!cleanKey) throw new Error('memory key must be non-empty');
    const cleanFact = input.fact.trim().slice(0, MAX_FACT_LENGTH);
    if (!cleanFact) throw new Error('memory fact must be non-empty');

    const tags = (input.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10);

    const bucket = await this.resolveBucketKey(input.workspace);
    const all = await this.readAll();
    const list = [...(all[bucket] ?? [])].filter((e) => e.key !== cleanKey);

    const entry: MemoryEntry = {
      key: cleanKey,
      fact: cleanFact,
      tags,
      updatedAt: Date.now(),
    };
    list.unshift(entry);
    all[bucket] = list.slice(0, MAX_ENTRIES_PER_WORKSPACE);
    await this.backend.set(MEMORY_STORAGE_KEY, all);
    return entry;
  }

  async recall(input: {
    query?: string;
    tag?: string;
    limit?: number;
    workspace?: string;
  } = {}): Promise<MemoryEntry[]> {
    const bucket = await this.resolveBucketKey(input.workspace);
    const all = await this.readAll();
    const list = all[bucket] ?? [];
    const needle = input.query?.trim().toLowerCase() ?? '';
    const tagFilter = input.tag?.trim().toLowerCase() ?? '';
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));

    return list
      .filter((entry) => {
        if (tagFilter && !entry.tags.includes(tagFilter)) return false;
        if (!needle) return true;
        return (
          entry.key.toLowerCase().includes(needle) ||
          entry.fact.toLowerCase().includes(needle) ||
          entry.tags.some((t) => t.includes(needle))
        );
      })
      .slice(0, limit);
  }

  async forget(key: string, workspace?: string): Promise<boolean> {
    const cleanKey = key.trim();
    const bucket = await this.resolveBucketKey(workspace);
    const all = await this.readAll();
    const before = all[bucket] ?? [];
    const after = before.filter((e) => e.key !== cleanKey);
    if (after.length === before.length) return false;
    all[bucket] = after;
    await this.backend.set(MEMORY_STORAGE_KEY, all);
    return true;
  }
}

export const defaultMemoryStore = new ProjectMemoryStore();
