/**
 * Phase 8 — User-Allowlisted Local MCP Server Registry.
 *
 * Security invariant: ChatGPT never specifies raw `command` / `args` strings.
 * Only user-configured `serverId` entries stored in `chrome.storage.local` can
 * be launched by the Rust Native Host MCP stdio bridge.
 */

import { browser } from 'wxt/browser';
import type { KeyValueBackend } from '../memory/store';

export const MCP_SERVERS_STORAGE_KEY = 'mcp.servers.v1';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

const fallbackMcpMap = new Map<string, unknown>();

const defaultMcpBackend: KeyValueBackend = {
  async get(key: string): Promise<unknown> {
    try {
      if (browser?.storage?.local) {
        const res = await browser.storage.local.get(key);
        return res[key];
      }
    } catch {
      /* fallback */
    }
    return fallbackMcpMap.get(key);
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
    fallbackMcpMap.set(key, value);
  },
};

export class McpServerStore {
  constructor(private readonly backend: KeyValueBackend = defaultMcpBackend) {}

  async list(): Promise<McpServerConfig[]> {
    const raw = await this.backend.get(MCP_SERVERS_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is McpServerConfig =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as McpServerConfig).id === 'string' &&
        typeof (item as McpServerConfig).command === 'string' &&
        Array.isArray((item as McpServerConfig).args),
    );
  }

  async getEnabled(serverId: string): Promise<McpServerConfig | null> {
    const all = await this.list();
    const found = all.find((s) => s.id === serverId);
    if (!found || !found.enabled) return null;
    return found;
  }

  async upsert(input: {
    id: string;
    name?: string;
    command: string;
    args?: string[];
    enabled?: boolean;
  }): Promise<McpServerConfig> {
    const id = input.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    if (!id) throw new Error('MCP server id must be non-empty');
    const command = input.command.trim();
    if (!command) throw new Error('MCP server command must be non-empty');

    const entry: McpServerConfig = {
      id,
      name: input.name?.trim() || id,
      command,
      args: (input.args ?? []).map((a) => a.trim()).filter(Boolean),
      enabled: input.enabled ?? true,
    };

    const existing = (await this.list()).filter((s) => s.id !== id);
    existing.push(entry);
    await this.backend.set(MCP_SERVERS_STORAGE_KEY, existing);
    return entry;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    const list = await this.list();
    const updated = list.map((s) => (s.id === id ? { ...s, enabled } : s));
    await this.backend.set(MCP_SERVERS_STORAGE_KEY, updated);
    return updated;
  }

  async remove(id: string): Promise<McpServerConfig[]> {
    const list = await this.list();
    const updated = list.filter((s) => s.id !== id);
    await this.backend.set(MCP_SERVERS_STORAGE_KEY, updated);
    return updated;
  }
}

export const defaultMcpServerStore = new McpServerStore();
