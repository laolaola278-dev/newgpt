/**
 * demo_echo — the first GPT++ tool.
 *
 * Purpose: prove the full Agent Loop (detect → route → execute → inject →
 * continue) with zero real-world side effects. It echoes text back.
 */

import type { ToolDefinition } from './types';

export const demoEchoTool: ToolDefinition = {
  name: 'demo_echo',
  description:
    'Echoes the given text back verbatim. Used to verify the GPT++ agent loop end-to-end.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  risk: 'safe',
  async execute(args) {
    return { text: args['text'] };
  },
};
