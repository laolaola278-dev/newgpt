/**
 * Phase 4 — Workspace-confined filesystem tool definitions.
 *
 * Execution happens inside `gptpp-native` (Rust) after both the extension
 * gateway and the native sandbox confirm confinement within `workspace.root`.
 */

import type { ToolDefinition } from './types';

function nativeOnly(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} executes inside the GPT++ Native Host`);
  };
}

export const fsListDirTool: ToolDefinition = {
  name: 'fs_list_dir',
  description: 'List files and directories at a workspace-relative path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path inside workspace (defaults to ".").' },
      maxEntries: { type: 'number', description: 'Maximum entries to return (default 200).' },
    },
    additionalProperties: false,
  },
  risk: 'read',
  execution: 'native',
  execute: nativeOnly('fs_list_dir'),
};

export const fsReadFileTool: ToolDefinition = {
  name: 'fs_read_file',
  description: 'Read UTF-8 text from a file within the configured workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      offset: { type: 'number', description: '1-based starting line number (optional).' },
      limit: { type: 'number', description: 'Maximum number of lines to read (optional).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  risk: 'read',
  execution: 'native',
  execute: nativeOnly('fs_read_file'),
};

export const fsWriteFileTool: ToolDefinition = {
  name: 'fs_write_file',
  description: 'Write UTF-8 text to a file inside the configured workspace, creating parent folders if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      content: { type: 'string', description: 'Full UTF-8 file content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  risk: 'write',
  execution: 'native',
  execute: nativeOnly('fs_write_file'),
};

export const fsSearchTool: ToolDefinition = {
  name: 'fs_search',
  description: 'Search workspace text files for a literal substring match.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Non-empty literal query string.' },
      path: { type: 'string', description: 'Optional subdirectory inside workspace.' },
      maxResults: { type: 'number', description: 'Maximum matches to return (default 50).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: 'read',
  execution: 'native',
  execute: nativeOnly('fs_search'),
};

export const filesystemTools: readonly ToolDefinition[] = [
  fsListDirTool,
  fsReadFileTool,
  fsWriteFileTool,
  fsSearchTool,
];
