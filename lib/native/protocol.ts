/**
 * Chrome Native Messaging framing — pure functions, no I/O.
 *
 *   u32 little-endian length + UTF-8 JSON payload
 *
 * The real transport (chrome.runtime.connectNative) does its own framing;
 * these helpers exist for tests, debugging tools and any future raw-stdio
 * transport. FrameDecoder tolerates chunked delivery and never allocates
 * based on attacker-controlled lengths above MAX_FRAME_BYTES.
 */

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Encode one frame: 4-byte LE length header + payload bytes. */
export function encodeFrame(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${body.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true); // little-endian
  out.set(body, 4);
  return out;
}

export type DecodeEvent =
  | { kind: 'message'; value: unknown }
  | { kind: 'malformed-json'; raw: string }
  | { kind: 'oversized'; declaredLength: number };

/**
 * Incremental decoder: feed transport chunks, receive decoded envelopes.
 * State machine keeps partial frames across feeds.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): DecodeEvent[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const events: DecodeEvent[] = [];
    let consumed = 0;

    while (this.buffer.length - consumed >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + consumed);
      const len = view.getUint32(0, true);
      if (len > MAX_FRAME_BYTES) {
        // Framing is desynced beyond repair; drop everything we have.
        consumed = this.buffer.length;
        events.push({ kind: 'oversized', declaredLength: len });
        continue;
      }
      const total = 4 + len;
      if (this.buffer.length - consumed < total) break; // wait for more bytes
      if (len === 0) {
        consumed += total;
        continue; // zero-length payload carries nothing — ignore silently
      }

      const slice = this.buffer.subarray(consumed + 4, consumed + total);
      const raw = new TextDecoder().decode(slice);
      try {
        events.push({ kind: 'message', value: JSON.parse(raw) });
      } catch {
        events.push({ kind: 'malformed-json', raw });
      }
      consumed += total;
    }

    this.buffer = this.buffer.slice(consumed);
    return events;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
