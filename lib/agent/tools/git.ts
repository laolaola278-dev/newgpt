/**
 * Phase 6 — Workspace-Confined Native Git Tools.
 *
 * Every Git capability executes under the explicit `GIT` permission scope via
 * the Rust Native Host (`std::process::Command::new("git")` with zero shell
 * interpolation and strict workspace path confinement).
 */

import type { ToolDefinition } from './types';

const nativeStub =
  (toolName: string) =>
  async (): Promise<never> => {
    throw new Error(`${toolName} is a native tool and must run via NativeBridge`);
  };

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description:
    'Inspect current Git branch and modified/staged/untracked files in workspace',
  risk: 'git',
  scope: 'GIT',
  execution: 'native',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: nativeStub('git_status'),
};

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description:
    'Inspect unified Git diff (working tree or staged) within the workspace',
  risk: 'git',
  scope: 'GIT',
  execution: 'native',
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Inspect staged changes (--staged) instead of unstaged changes',
      },
      path: {
        type: 'string',
        description: 'Optional relative file path within workspace',
      },
      contextLines: {
        type: 'number',
        description: 'Diff context lines (default 3, max 20)',
      },
    },
  },
  execute: nativeStub('git_diff'),
};

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Read recent structured Git commit history in the workspace',
  risk: 'git',
  scope: 'GIT',
  execution: 'native',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of commits to return (1–50, default 10)',
      },
    },
  },
  execute: nativeStub('git_log'),
};

export const gitStageTool: ToolDefinition = {
  name: 'git_stage',
  description: 'Stage specific workspace-confined files for Git commit',
  risk: 'git',
  scope: 'GIT',
  execution: 'native',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relative file paths inside workspace to stage',
      },
    },
    required: ['paths'],
  },
  execute: nativeStub('git_stage'),
};

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Create a local Git commit from staged changes with an explicit message',
  risk: 'git',
  scope: 'GIT',
  execution: 'native',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message summarizing the staged changes',
      },
    },
    required: ['message'],
  },
  execute: nativeStub('git_commit'),
};

export const gitTools: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitStageTool,
  gitCommitTool,
];
