import { describe, expect, it, vi } from 'vitest';
import { NativeMessagingClient } from '@/lib/native/client';
import { GptppNativeError } from '@/lib/native/errors';
import type { NativePortLike } from '@/lib/native/types';

class MockPort implements NativePortLike {
  sent: unknown[] = [];
  disconnected = false;
  private msgListeners = new Set<(m: unknown) => void>();
  private discListeners = new Set<() => void>();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  onMessage = {
    addListener: (f: (m: unknown) => void) => this.msgListeners.add(f),
    removeListener: (f: (m: unknown) => void) => this.msgListeners.delete(f),
  };

  onDisconnect = {
    addListener: (f: () => void) => this.discListeners.add(f),
    removeListener: (f: () => void) => this.discListeners.delete(f),
  };

  emitMessage(m: unknown): void {
    for (const f of [...this.msgListeners]) f(m);
  }

  emitDisconnect(): void {
    for (const f of [...this.discListeners]) f();
  }
}

const CAPS = {
  name: 'com.gptpp.native',
  version: '0.1.0',
  protocolVersion: 1,
  capabilities: ['native_echo'],
};

function makeClient(port: MockPort, opts?: { handshakeTimeoutMs?: number; requestTimeoutMs?: number }) {
  const client = new NativeMessagingClient({
    portFactory: () => port,
    ...opts,
  });
  return client;
}

function lastSent(port: MockPort): { id: string; method: string; params?: unknown } {
  return port.sent[port.sent.length - 1] as never;
}

/**
 * Drive the handshake on the mock port: answer whatever hello the client sent
 * with a valid capabilities frame, then await connect().
 */
async function handshake(client: NativeMessagingClient, port: MockPort) {
  const pending = client.connect();
  const hello = lastSent(port) as { id: string };
  port.emitMessage({ id: hello.id, ok: true, result: CAPS });
  return pending;
}

describe('NativeMessagingClient', () => {
  it('connects, handshakes and stores verified capabilities', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    const pending = client.connect();
    const hello = port.sent[0] as { id: string; method: string; params: { protocolVersion: number } };
    expect(hello.method).toBe('hello');
    expect(hello.params.protocolVersion).toBe(1);
    port.emitMessage({ id: hello.id, ok: true, result: CAPS });
    await expect(pending).resolves.toEqual(CAPS);
    expect(client.isConnected()).toBe(true);
    expect(client.getState()).toBe('CONNECTED');
  });

  it('rejects protocol version mismatches and does not stay connected', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    const pending = client.connect();
    const hello = port.sent[0] as { id: string };
    port.emitMessage({
      id: hello.id,
      ok: true,
      result: { ...CAPS, protocolVersion: 99 },
    });
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' });
    expect(client.isConnected()).toBe(false);
    expect(port.disconnected).toBe(true);
  });

  it('rejects wrong host names', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    const pending = client.connect();
    const hello = port.sent[0] as { id: string };
    port.emitMessage({
      id: hello.id,
      ok: true,
      result: { ...CAPS, name: 'someone-else' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' });
  });

  it('times out when the handshake never answers', async () => {
    vi.useFakeTimers();
    const port = new MockPort();
    const client = makeClient(port, { handshakeTimeoutMs: 100 });
    const pending = client.connect();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'HANDSHAKE_FAILED' });
    vi.advanceTimersByTime(150);
    await assertion;
    vi.useRealTimers();
  });

  it('matches responses to requests by id across interleaving', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port); // handshake consumed sent[0]

    const p1 = client.request('native_echo', { text: 'one' });
    const p2 = client.request('native_echo', { text: 'two' });
    const s1 = port.sent[1] as { id: string };
    const s2 = port.sent[2] as { id: string };
    // Answer out of order — ids must route correctly.
    port.emitMessage({ id: s2.id, ok: true, result: { text: 'two', host: 'gptpp-native' } });
    port.emitMessage({ id: s1.id, ok: true, result: { text: 'one', host: 'gptpp-native' } });
    await expect(p2).resolves.toMatchObject({ result: { text: 'two' } });
    await expect(p1).resolves.toMatchObject({ result: { text: 'one' } });
  });

  it('surfaces host-side errors as structured rejections', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port);
    const p = client.request('read_file');
    const sent = port.sent[1] as { id: string };
    port.emitMessage({
      id: sent.id,
      ok: false,
      error: { code: 'UNKNOWN_METHOD', message: 'Unknown GPT++ native method: read_file' },
    });
    await expect(p).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('times out requests and frees the pending slot', async () => {
    vi.useFakeTimers();
    const port = new MockPort();
    const client = makeClient(port, { requestTimeoutMs: 200 });
    await handshake(client, port);
    const p = client.request('native_echo', { text: 'x' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    vi.advanceTimersByTime(250);
    await assertion;
    // A late reply must not crash or resurrect anything.
    expect(() => port.emitMessage({ id: (port.sent[1] as { id: string }).id, ok: true, result: {} })).not.toThrow();
    vi.useRealTimers();
  });

  it('ignores malformed frames without killing the connection', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port);
    port.emitMessage('garbage');
    port.emitMessage(null);
    expect(client.isConnected()).toBe(true);
  });

  it('rejects all pending requests when the host disconnects', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port);
    const p = client.request('native_echo', { text: 'x' });
    port.emitDisconnect();
    await expect(p).rejects.toMatchObject({ code: 'NATIVE_HOST_UNAVAILABLE' });
    expect(client.getState()).toBe('DISCONNECTED');
    expect(client.getLastErrorCode()).toBe('NATIVE_HOST_UNAVAILABLE');
  });

  it('reconnects after a disconnect', async () => {
    const ports = [new MockPort(), new MockPort()];
    let i = 0;
    const client = new NativeMessagingClient({ portFactory: () => ports[i++]! });
    {
      const p0 = client.connect();
      const hello0 = ports[0]!.sent[0] as { id: string };
      ports[0]!.emitMessage({ id: hello0.id, ok: true, result: CAPS });
      await p0;
    }
    ports[0]!.emitDisconnect();
    expect(client.isConnected()).toBe(false);

    const pending = client.reconnect();
    const hello = ports[1]!.sent[0] as { id: string };
    ports[1]!.emitMessage({ id: hello.id, ok: true, result: CAPS });
    await pending;
    expect(client.isConnected()).toBe(true);
  });

  it('cancels pending requests locally and notifies the host', async () => {
    vi.useFakeTimers();
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port);
    const p = client.request('slow_thing');
    const sent = port.sent[1] as { id: string };
    const assertion = expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    client.cancel(sent.id);
    await assertion;
    expect(port.sent.at(-1)).toMatchObject({ method: 'cancel' });
    vi.useRealTimers();
  });

  it('refuses to send when not connected', async () => {
    const client = new NativeMessagingClient({ portFactory: () => new MockPort() });
    await expect(client.request('native_echo')).rejects.toMatchObject({
      code: 'NATIVE_HOST_UNAVAILABLE',
    });
  });

  it('disconnect() is clean and idempotent', () => {
    const port = new MockPort();
    const client = makeClient(port);
    client.disconnect();
    expect(() => client.disconnect()).not.toThrow();
    expect(client.getState()).toBe('DISCONNECTED');
  });

  it('rejects immediately and cleans up timer if port.postMessage throws during request()', async () => {
    const port = new MockPort();
    const client = makeClient(port);
    await handshake(client, port);
    port.postMessage = () => {
      throw new Error('pipe closed');
    };
    await expect(client.request('native_echo', { text: 'boom' })).rejects.toMatchObject({
      code: 'NATIVE_HOST_UNAVAILABLE',
    });
  });
});
