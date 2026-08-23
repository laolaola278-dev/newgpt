import { describe, expect, it } from 'vitest';
import { StreamingToolCallParser } from '@/lib/agent/tool-call/parser';
import type { ToolCall } from '@/lib/agent/tool-call/types';

function envelope(id: string, body: string): string {
  return `<gptpp:tool_call id="${id}">\n${body}\n</gptpp:tool_call>`;
}

const ECHO = envelope('call_001', '{"name":"demo_echo","arguments":{"text":"hello"}}');

describe('StreamingToolCallParser', () => {
  it('ignores plain prose (no calls, status IDLE)', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed('我建议你修改这个函数，然后运行测试。');
    expect(res.calls).toHaveLength(0);
    expect(res.issues).toHaveLength(0);
    expect(p.getStatus()).toBe('IDLE');
  });

  it('never treats bare JSON in prose as a tool call', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed('你可以发送 {"name":"demo_echo","arguments":{"text":"x"}} 试试。');
    expect(res.calls).toHaveLength(0);
    expect(p.getStatus()).toBe('IDLE');
  });

  it('parses a complete envelope with id, name and arguments', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed(`Sure! ${ECHO} Done.`);
    expect(res.calls).toEqual([
      { id: 'call_001', name: 'demo_echo', arguments: { text: 'hello' } },
    ]);
    expect(p.getStatus()).toBe('COMPLETE');
  });

  it('parses multiple envelopes in one message in order', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed(
      [
        ECHO,
        envelope('call_002', '{"name":"demo_echo","arguments":{"text":"second"}}'),
      ].join('\n'),
    );
    expect(res.calls.map((c: ToolCall) => c.id)).toEqual(['call_001', 'call_002']);
  });

  it('reports POSSIBLE_TOOL_CALL for a partial opening tag while streaming', () => {
    const p = new StreamingToolCallParser();
    p.feed('working on it <gptpp:tool');
    expect(p.getStatus()).toBe('POSSIBLE_TOOL_CALL');
    const res = p.feed(`working on it ${ECHO}`);
    expect(res.calls).toHaveLength(1);
    expect(p.getStatus()).toBe('COMPLETE');
  });

  it('reports READING_TOOL_CALL between open and close tags', () => {
    const p = new StreamingToolCallParser();
    p.feed(`${'<gptpp:tool_call id="call_9">'}{"name":"demo_ech`);
    expect(p.getStatus()).toBe('READING_TOOL_CALL');
  });

  it('flags invalid JSON inside a well-formed envelope', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed(envelope('call_bad', '{not json'));
    expect(res.calls).toHaveLength(0);
    expect(res.issues[0]?.code).toBe('INVALID_JSON');
    expect(res.issues[0]?.callId).toBe('call_bad');
    expect(p.getStatus()).toBe('INVALID');
  });

  it('requires the id attribute', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed('<gptpp:tool_call>{"name":"demo_echo"}</gptpp:tool_call>');
    expect(res.calls).toHaveLength(0);
    expect(res.issues[0]?.code).toBe('MISSING_ID');
  });

  it('rejects unknown top-level fields', () => {
    const p = new StreamingToolCallParser();
    const res = p.feed(
      envelope('call_x', '{"name":"demo_echo","arguments":{},"evil":"yes"}'),
    );
    expect(res.calls).toHaveLength(0);
    expect(res.issues[0]?.code).toBe('UNKNOWN_FIELD');
    expect(p.getStatus()).toBe('INVALID');
  });

  it('emits each envelope exactly once across repeated snapshots', () => {
    const p = new StreamingToolCallParser();
    p.feed(ECHO);
    const again = p.feed(ECHO);
    expect(again.calls).toHaveLength(0);
  });

  it('resets when the snapshot shrinks or diverges', () => {
    const p = new StreamingToolCallParser();
    p.feed(`intro ${ECHO}`);
    const res = p.feed('fresh short');
    expect(res.calls).toHaveLength(0);
    expect(p.getStatus()).toBe('IDLE');
    // And it can parse a new call afterwards.
    const next = p.feed(ECHO);
    expect(next.calls).toHaveLength(1);
  });
});
