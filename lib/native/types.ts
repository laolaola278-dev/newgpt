/**
 * Types for the Native Messaging layer.
 *
 * The port is abstracted behind NativePortLike so the whole client can be
 * exercised in unit tests without Chrome. In production the factory is
 * `() => browser.runtime.connectNative(hostName)`.
 */

export type NativeConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'ERROR';

export interface HostCapabilities {
  name: string;
  version: string;
  protocolVersion: number;
  capabilities: string[];
}

export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

export type NativePortFactory = () => NativePortLike;

export interface NativeMessagingClientOptions {
  hostName?: string;
  protocolVersion?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  portFactory?: NativePortFactory;
}
