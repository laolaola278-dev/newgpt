/**
 * Phase 8 — Local MCP Ecosystem Agent Tools (`mcp_*`) + Browser Scope Tool (`browser_*`).
 */

import { browser } from 'wxt/browser';
import type { ToolDefinition } from './types';
import { defaultMcpServerStore, type McpServerStore } from '../mcp/store';

export function createMcpTools(
  store: McpServerStore = defaultMcpServerStore,
): ToolDefinition[] {
  const listServersTool: ToolDefinition = {
    name: 'mcp_list_servers',
    description:
      'List user-configured local MCP servers and their active status',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const servers = await store.list();
      return {
        servers: servers.map(({ id, name, enabled }) => ({ id, name, enabled })),
      };
    },
  };

  const listToolsTool: ToolDefinition = {
    name: 'mcp_list_tools',
    description:
      'Discover tools exposed by an enabled local MCP server over stdio JSON-RPC',
    risk: 'execute',
    scope: 'EXECUTE',
    execution: 'native',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: {
          type: 'string',
          description: 'Configured MCP server id from mcp_list_servers',
        },
      },
      required: ['serverId'],
      additionalProperties: false,
    },
    async execute() {
      throw new Error('mcp_list_tools runs via NativeBridge');
    },
  };

  const callTool: ToolDefinition = {
    name: 'mcp_call_tool',
    description:
      'Invoke a tool on an allowlisted local MCP server via the Rust Native Host',
    risk: 'execute',
    scope: 'EXECUTE',
    execution: 'native',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: {
          type: 'string',
          description: 'Configured MCP server id from mcp_list_servers',
        },
        toolName: {
          type: 'string',
          description: 'Tool name advertised by the MCP server',
        },
        arguments: {
          type: 'object',
          description: 'Structured JSON arguments passed to tools/call',
        },
      },
      required: ['serverId', 'toolName'],
      additionalProperties: false,
    },
    async execute() {
      throw new Error('mcp_call_tool runs via NativeBridge');
    },
  };

  return [listServersTool, listToolsTool, callTool];
}

export const browserListTabsTool: ToolDefinition = {
  name: 'browser_list_tabs',
  description:
    'List currently open browser tabs (id, title, active state, origin) under BROWSER scope',
  risk: 'browser',
  scope: 'BROWSER',
  execution: 'local',
  inputSchema: {
    type: 'object',
    properties: {
      activeOnly: {
        type: 'boolean',
        description: 'Return only active window tabs when true',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const activeOnly = Boolean(args['activeOnly']);
    const tabs = await browser.tabs.query(activeOnly ? { active: true } : {});
    return {
      tabs: tabs.slice(0, 30).map((t) => ({
        id: t.id ?? null,
        title: t.title ?? '',
        url: t.url ?? '',
        active: Boolean(t.active),
      })),
    };
  },
};

export const mcpTools = createMcpTools();
export const browserTools: ToolDefinition[] = [browserListTabsTool];
