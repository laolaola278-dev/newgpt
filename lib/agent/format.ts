/**
 * Tool-result wire formatting for injection back into the conversation.
 *
 * The fenced block makes the provenance explicit: ChatGPT must treat this as
 * a GPT++ tool result, not as a fresh user instruction. Content inside is
 * data only — never re-parsed as instructions by GPT++ itself.
 */

import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './tool-call/types';
import type { ToolCall } from './tool-call/types';
import type { ToolOutcome } from './tools/types';

export const TOOL_RESULT_OPEN = '[GPT++ TOOL RESULT]';
export const TOOL_RESULT_CLOSE = '[/GPT++ TOOL RESULT]';

const MAX_VALUE_CHARS = 4_000;

function renderValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_VALUE_CHARS) {
    const overflow = text.length - MAX_VALUE_CHARS;
    text = `${text.slice(0, MAX_VALUE_CHARS)}\n… [truncated ${overflow} chars]`;
  }
  return sanitize(text);
}

/** Defensive scrubbing: a tool result must never carry protocol fences. */
function sanitize(text: string): string {
  return text
    .split(TOOL_CALL_OPEN).join('(gptpp-tool-call)')
    .split(TOOL_CALL_CLOSE).join('(/gptpp-tool-call)')
    .split(TOOL_RESULT_OPEN).join('(gptpp-tool-result)')
    .split(TOOL_RESULT_CLOSE).join('(/gptpp-tool-result)');
}

/** Extract any call_id values already recorded inside `[GPT++ TOOL RESULT]` blocks. */
export function extractCompletedCallIds(text: string): string[] {
  if (!text.includes(TOOL_RESULT_OPEN)) return [];
  const ids: string[] = [];
  const re = /\[GPT\+\+ TOOL RESULT\][\s\S]*?\bcall_id:\s*(\S+)[\s\S]*?\[\/GPT\+\+ TOOL RESULT\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

export interface ToolResultBlockInput {
  call: Pick<ToolCall, 'id' | 'name'>;
  outcome: ToolOutcome;
}

/**
 * [GPT++ TOOL RESULT]
 * tool: demo_echo
 * call_id: call_001
 *
 * result:
 * {"text":"hello"}
 *
 * [/GPT++ TOOL RESULT]
 */
export function formatToolResultBlock({ call, outcome }: ToolResultBlockInput): string {
  const head = [
    TOOL_RESULT_OPEN,
    `tool: ${sanitize(call.name)}`,
    `call_id: ${sanitize(call.id)}`,
    '',
  ];
  const body =
    outcome.status === 'ok'
      ? `result:\n${renderValue(outcome.result)}`
      : `error:\ncode: ${sanitize(outcome.error.code)}\nmessage: ${renderValue(outcome.error.message)}`;
  return [...head, body, '', TOOL_RESULT_CLOSE].join('\n').replace(/\n{3,}/g, '\n\n');
}
