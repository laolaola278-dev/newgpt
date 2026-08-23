/**
 * native_echo — first capability executed inside the Rust Native Host.
 *
 * The definition is declarative only: `execution: 'native'` makes the router
 * send it through the Native Bridge (Chrome Native Messaging → gptpp-native).
 * `execute` below is a guard and must never run in the extension.
 */

import type { ToolDefinition } from './types';

export const nativeEchoTool: ToolDefinition = {
  name: 'native_echo',
  description:
    'Echoes the given text back via the GPT++ Rust Native Host. Proves the real extension → native messaging → host link.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  risk: 'low',
  execution: 'native',
  async execute() {
    throw new Error('native_echo runs in the Native Host, never inside the extension');
  },
};
