/**
 * GPT++ Tool Call Protocol — wire format and types.
 *
 * ChatGPT has no native tool-call channel, so GPT++ defines an explicit,
 * fenced protocol the model is asked to emit inside its reply:
 *
 *   <gptpp:tool_call id="call_001">
 *   {"name":"demo_echo","arguments":{"text":"hello"}}
 *   </gptpp:tool_call>
 *
 * Design rules:
 *  - Plain JSON in prose is NEVER a tool call — only the exact fence counts.
 *  - The envelope carries the call id; the JSON body carries name+arguments.
 *  - Unknown top-level fields are rejected (strict, extensible via versions).
 *  - Results travel back in a separate fenced block (see lib/agent/format).
 */

export const TOOL_CALL_OPEN = '<gptpp:tool_call';
export const TOOL_CALL_CLOSE = '</gptpp:tool_call>';

/** Matches: <gptpp:tool_call ...attrs...> body </gptpp:tool_call> */
export const ENVELOPE_RE =
  /<gptpp:tool_call\b([^>]*)>([\s\S]*?)<\/gptpp:tool_call>/g;

export function extractEnvelopeId(attrs: string): string | null {
  const m = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
  return m?.[1] && m[1].length > 0 ? m[1] : null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ParseIssueCode = 'INVALID_JSON' | 'MISSING_ID' | 'UNKNOWN_FIELD';

export interface ParseIssue {
  code: ParseIssueCode;
  message: string;
  callId?: string;
  toolName?: string;
}

export interface ParserFeedResult {
  calls: ToolCall[];
  issues: ParseIssue[];
}
