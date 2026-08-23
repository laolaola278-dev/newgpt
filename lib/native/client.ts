/**
 * NativeMessagingClient — the extension side of Chrome Native Messaging.
 *
 * Owns:
 *  - connection state machine (DISCONNECTED/CONNECTING/CONNECTED/…)
 *  - handshake + capability/version verification
 *  - pending-request map with id matching and timeouts
 *  - disconnect detection, pending cleanup, cancellation, reconnection
 *
 * Transport-agnostic: the port comes from an injectable factory so tests run
 * against a mock. In production it is chrome.runtime.connectNative().
 */

import { browser } from 'wxt/browser';
import { createRequest, isResponse } from '@/lib/protocol';
import { GptppNativeError, nativeUnavailable, type NativeErrorCode } from './errors';
import type {
  HostCapabilities,
  NativeConnectionState,
  NativeMessagingClientOptions,
  NativePortFactory,
  NativePortLike,
} from './types';

export const HOST_NAME = 'gptpp-native';
export const PROTOCOL_VERSION = 1;

interface PendingRequest {
  resolve: (value: { ok: true; result: unknown }) => void;
  reject: (err: GptppNativeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NativeMessagingClient {
  private state: NativeConnectionState = 'DISCONNECTED';
  private port: NativePortLike | null = null;
  private capabilities: HostCapabilities | null = null;
  private lastErrorCode: NativeErrorCode | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private connecting: Promise<HostCapabilities> | null = null;
  private intentionalDisconnect = false;

  private readonly hostName: string;
  private readonly protocolVersion: number;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly newPort: NativePortFactory;

  constructor(options: NativeMessagingClientOptions = {}) {
    this.hostName = options.hostName ?? HOST_NAME;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 4000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.newPort =
      options.portFactory ?? (() => browser.runtime.connectNative(this.hostName));
  }

  getState(): NativeConnectionState {
    return this.state;
  }

  getCapabilities(): HostCapabilities | null {
    return this.capabilities;
  }

  getLastErrorCode(): NativeErrorCode | null {
    return this.lastErrorCode;
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED';
  }

  /** Connect + handshake. Resolves with verified host capabilities. */
  async connect(): Promise<HostCapabilities> {
    if (this.state === 'CONNECTED' && this.capabilities) return this.capabilities;
    if (this.connecting) return this.connecting;

    this.intentionalDisconnect = false;
    this.setState('CONNECTING');
    this.connecting = this.runHandshake();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  disconnect(): void {
    if (!this.port && this.state === 'DISCONNECTED') return;
    this.intentionalDisconnect = true;
    this.setState('DISCONNECTING');
    this.rejectAllPending('NATIVE_HOST_UNAVAILABLE', 'client disconnected');
    if (this.port) {
      this.detachListeners(this.port);
      try {
        this.port.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.port = null;
    this.capabilities = null;
    this.setState('DISCONNECTED');
  }

  /** Disconnect (if needed) then connect again. */
  async reconnect(): Promise<HostCapabilities> {
    this.disconnect();
    return this.connect();
  }

  /**
   * Send one RPC request. Rejects with structured GptppNativeError on
   * unavailability, timeout, disconnect or malformed reply.
   */
  request(method: string, params?: unknown): Promise<{ ok: true; result: unknown }> {
    if (this.state !== 'CONNECTED' || !this.port) {
      return Promise.reject(nativeUnavailable());
    }
    const envelope = createRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(
          new GptppNativeError(
            'TIMEOUT',
            `native request "${method}" exceeded ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(envelope.id, { resolve, reject, timer });
      this.safePost(envelope);
    });
  }

  /** Abandon a pending request locally and notify the host (best effort). */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.reject(new GptppNativeError('CANCELLED', `request ${requestId} cancelled`));
    if (this.state === 'CONNECTED') {
      this.safePost(createRequest('cancel', { requestId }));
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private setState(next: NativeConnectionState, code?: NativeErrorCode): void {
    this.state = next;
    if (code !== undefined) this.lastErrorCode = code;
    if (next === 'CONNECTED') this.lastErrorCode = null;
  }

  private safePost(message: unknown): boolean {
    try {
      this.port?.postMessage(message);
      return true;
    } catch (err) {
      console.error('[GPT++] native postMessage failed', err);
      return false;
    }
  }

  private rejectAllPending(code: NativeErrorCode, message: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new GptppNativeError(code, message));
    }
    this.pending.clear();
  }

  private readonly onPortMessage = (raw: unknown): void => {
    if (!isResponse(raw)) {
      console.error('[GPT++] native: malformed frame ignored');
      return;
    }
    const entry = this.pending.get(raw.id);
    if (!entry) return; // late/duplicate/unknown id — ignore safely
    this.pending.delete(raw.id);
    clearTimeout(entry.timer);
    if (raw.ok) {
      entry.resolve({ ok: true, result: raw.result });
    } else {
      entry.reject(
        new GptppNativeError('MALFORMED_RESPONSE', `${raw.error.code}: ${raw.error.message}`),
      );
    }
  };

  private readonly onPortDisconnect = (): void => {
    if (this.intentionalDisconnect) return; // handled by disconnect()
    this.rejectAllPending('NATIVE_HOST_UNAVAILABLE', 'native host closed the connection');
    if (this.port) this.detachListeners(this.port);
    this.port = null;
    this.capabilities = null;
    this.setState('ERROR', 'NATIVE_HOST_UNAVAILABLE');
    this.setState('DISCONNECTED');
  };

  private detachListeners(port: NativePortLike): void {
    port.onMessage.removeListener(this.onPortMessage);
    port.onDisconnect.removeListener(this.onPortDisconnect);
  }

  private async runHandshake(): Promise<HostCapabilities> {
    let port: NativePortLike;
    try {
      port = this.newPort();
    } catch (err) {
      this.setState('ERROR', 'NATIVE_HOST_UNAVAILABLE');
      throw nativeUnavailable(
        err instanceof Error ? `cannot open native port: ${err.message}` : undefined,
      );
    }
    this.port = port;
    port.onMessage.addListener(this.onPortMessage);
    port.onDisconnect.addListener(this.onPortDisconnect);

    try {
      const res = await new Promise<{ ok: true; result: unknown }>((resolve, reject) => {
        const handshakeId = createRequest('hello').id;
        const timer = setTimeout(() => {
          this.pending.delete(handshakeId);
          reject(
            new GptppNativeError(
              'HANDSHAKE_FAILED',
              `handshake did not complete within ${this.handshakeTimeoutMs}ms`,
            ),
          );
        }, this.handshakeTimeoutMs);
        this.pending.set(handshakeId, { resolve, reject, timer });
        if (!this.safePost({
          id: handshakeId,
          method: 'hello',
          params: { protocolVersion: this.protocolVersion },
        })) {
          this.pending.delete(handshakeId);
          clearTimeout(timer);
          throw nativeUnavailable('cannot write to native port');
        }
      });

      // The pending map already normalized the reply to {ok, result}.
      const caps = res.result as Partial<HostCapabilities>;
      if (
        typeof caps !== 'object' ||
        caps.name !== this.hostName ||
        caps.protocolVersion !== this.protocolVersion ||
        !Array.isArray(caps.capabilities)
      ) {
        throw new GptppNativeError(
          'PROTOCOL_VERSION_MISMATCH',
          `host reported name=${String(caps?.name)} protocol=${String(caps?.protocolVersion)}, expected ${this.hostName}/v${this.protocolVersion}`,
        );
      }
      this.capabilities = {
        name: caps.name,
        version: String(caps.version ?? ''),
        protocolVersion: caps.protocolVersion,
        capabilities: caps.capabilities,
      };
      this.setState('CONNECTED');
      return this.capabilities;
    } catch (err) {
      const gerr =
        err instanceof GptppNativeError
          ? err
          : new GptppNativeError('HANDSHAKE_FAILED', 'handshake failed');
      this.rejectAllPending(gerr.code, gerr.message);
      this.detachListeners(port);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      this.port = null;
      this.setState('ERROR', gerr.code);
      throw gerr;
    }
  }
}
