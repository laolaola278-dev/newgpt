/**
 * Streaming-safe incremental Tool Call parser.
 *
 * Fed with FULL snapshots of the observed assistant message (the adapter
 * re-reports content as it streams). Internally it:
 *   - rescans the snapshot for complete envelopes (cheap at message sizes),
 *   - emits each envelope exactly once (tracked by match end offset),
 *   - tolerates partial trailing data ("possible"/"reading" states),
 *   - resets cleanly when a snapshot shrinks or diverges (message replaced).
 *
 * Plain prose — even prose containing `{"name":"foo"}` — can never become a
 * tool call; only the exact fenced envelope matches. Envelopes with unknown
 * top-level fields are rejected here (defense in depth: the validator layer
 * re-checks everything independently).
 */

import {
  ENVELOPE_RE,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  extractEnvelopeId,
  type ParseIssue,
  type ParserFeedResult,
  type ToolCall,
} from './types';

export type ToolCallParserStatus =
  | 'IDLE'
  | 'POSSIBLE_TOOL_CALL'
  | 'READING_TOOL_CALL'
  | 'COMPLETE'
  | 'INVALID';

function endsWithPrefixOf(text: string, marker: string): boolean {
  const max = Math.min(marker.length - 1, text.length);
  for (let len = max; len >= 1; len--) {
    if (text.endsWith(marker.slice(0, len))) return true;
  }
  return false;
}

export class StreamingToolCallParser {
  private buffer = '';
  private emittedUpTo = 0;
  private status: ToolCallParserStatus = 'IDLE';

  getStatus(): ToolCallParserStatus {
    return this.status;
  }

  reset(): void {
    this.buffer = '';
    this.emittedUpTo = 0;
    this.status = 'IDLE';
  }

  /**
   * Feed the latest full snapshot of an assistant message.
   * Returns newly completed calls and any structural issues found.
   */
  feed(fullText: string): ParserFeedResult {
    // Snapshot shrank or rewrote already-consumed content → start over.
    if (
      fullText.length < this.emittedUpTo ||
      fullText.slice(0, this.emittedUpTo) !== this.buffer.slice(0, this.emittedUpTo)
    ) {
      this.reset();
    }
    this.buffer = fullText;

    const calls: ToolCall[] = [];
    const issues: ParseIssue[] = [];

    ENVELOPE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENVELOPE_RE.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      if (end <= this.emittedUpTo) continue; // already emitted
      this.emittedUpTo = end;

      const attrs = match[1] ?? '';
      const body = (match[2] ?? '').trim();
      const attrId = extractEnvelopeId(attrs);
      const fail = (code: ParseIssue['code'], message: string): void => {
        issues.push({ code, message, callId: attrId ?? undefined });
        this.status = 'INVALID';
      };

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        fail('INVALID_JSON', 'tool call body is not valid JSON');
        continue;
      }

      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        fail('INVALID_JSON', 'tool call body must be a JSON object');
        continue;
      }
      const shaped = json as Record<string, unknown>;

      let rejectedByField = false;
      for (const key of Object.keys(shaped)) {
        if (!ALLOWED_FIELDS.has(key)) {
          fail('UNKNOWN_FIELD', `unknown field "${key}" in tool call body`);
          rejectedByField = true;
        }
      }
      if (rejectedByField) continue;

      if (!attrId) {
        fail('MISSING_ID', 'tool call envelope has no id attribute');
        continue;
      }

      if (typeof shaped.name !== 'string' || shaped.name.trim().length === 0) {
        fail('INVALID_JSON', 'tool call requires a non-empty string "name"');
        continue;
      }

      const rawArgs = shaped.arguments;
      if (
        rawArgs !== undefined &&
        rawArgs !== null &&
        (typeof rawArgs !== 'object' || Array.isArray(rawArgs))
      ) {
        fail('INVALID_JSON', 'tool call "arguments" must be a JSON object');
        continue;
      }

      calls.push({
        id: attrId,
        name: shaped.name,
        arguments:
          typeof rawArgs === 'object' && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {},
      });
    }

    if (issues.length === 0) this.status = this.computeStatus(calls.length > 0);
    return { calls, issues };
  }

  private computeStatus(emittedNow: boolean): ToolCallParserStatus {
    const lastOpen = this.buffer.lastIndexOf(TOOL_CALL_OPEN);
    const lastClose = this.buffer.lastIndexOf(TOOL_CALL_CLOSE);

    if (lastOpen !== -1 && lastClose < lastOpen) return 'READING_TOOL_CALL';
    if (endsWithPrefixOf(this.buffer, TOOL_CALL_OPEN)) return 'POSSIBLE_TOOL_CALL';
    if (emittedNow) return 'COMPLETE';
    return this.status === 'COMPLETE' ? 'COMPLETE' : 'IDLE';
  }
}

const ALLOWED_FIELDS = new Set(['name', 'arguments']);
