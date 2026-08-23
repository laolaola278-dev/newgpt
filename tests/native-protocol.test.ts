import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '@/lib/native/protocol';

function le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

describe('native frame protocol', () => {
  it('encodes u32 little-endian length + payload', () => {
    const frame = encodeFrame('{"a":1}');
    expect([...frame.slice(0, 4)]).toEqual(le(7));
    expect(new TextDecoder().decode(frame.slice(4))).toBe('{"a":1}');
  });

  it('decodes a full frame from one chunk', () => {
    const decoder = new FrameDecoder();
    const events = decoder.feed(encodeFrame('{"id":"r1","ok":true,"result":7}'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', value: { id: 'r1', result: 7 } });
  });

  it('reassembles frames delivered in split chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame('{"hello":"world"}');
    expect(decoder.feed(frame.slice(0, 2))).toHaveLength(0); // header only
    expect(decoder.feed(frame.slice(2, 5))).toHaveLength(0); // partial body
    const events = decoder.feed(frame.slice(5));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', value: { hello: 'world' } });
  });

  it('decodes consecutive frames in order', () => {
    const decoder = new FrameDecoder();
    const events = decoder.feed(
      new Uint8Array([...encodeFrame('[1]'), ...encodeFrame('[2]'), ...encodeFrame('[3]')]),
    );
    expect(events.map((e) => (e.kind === 'message' ? e.value : null))).toEqual([
      [1],
      [2],
      [3],
    ]);
  });

  it('flags malformed JSON instead of throwing', () => {
    const decoder = new FrameDecoder();
    const events = decoder.feed(encodeFrame('not json at all'));
    expect(events[0]?.kind).toBe('malformed-json');
    // decoder stays usable
    expect(decoder.feed(encodeFrame('"ok"'))[0]).toMatchObject({
      kind: 'message',
      value: 'ok',
    });
  });

  it('reports oversized declared lengths without allocating them', () => {
    const decoder = new FrameDecoder();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, true);
    const events = decoder.feed(header);
    expect(events[0]).toMatchObject({
      kind: 'oversized',
      declaredLength: MAX_FRAME_BYTES + 1,
    });
  });

  it('handles empty payloads', () => {
    const decoder = new FrameDecoder();
    const events = decoder.feed(encodeFrame(''));
    expect(events).toHaveLength(0); // empty payload parses to nothing useful — no crash
  });

  it('reset() clears partial state', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame('{"a":1}');
    decoder.feed(frame.slice(0, 3));
    decoder.reset();
    expect(decoder.feed(frame)).toHaveLength(1);
  });

  it('rejects encoding beyond the frame cap', () => {
    expect(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(/too large/);
  });
});
