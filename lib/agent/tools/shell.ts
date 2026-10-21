/**
 * Phase 4 — Controlled workspace shell execution tool.
 *
 * Commands execute strictly inside the verified workspace directory with
 * hard wall-clock timeouts and stdout/stderr byte ceilings enforced by the
 * Rust Native Host.
 */

import type { ToolDefinition } from './types';

export const shellExecTool: ToolDefinition = {
  name: 'shell_exec',
  description:
    'Execute a shell command inside the confined workspace directory with timeout and output limits.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command string to run in the workspace shell.' },
      cwd: { type: 'string', description: 'Optional subdirectory inside the workspace root.' },
      timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (max 60000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'execute',
  execution: 'native',
  async execute() {
    throw new Error('shell_exec executes inside the GPT++ Native Host');
  },
};
