/**
 * Structured errors for the native layer. Codes are stable strings — they
 * cross RPC boundaries and end up visible to ChatGPT via tool results.
 */

export type NativeErrorCode =
  | 'NATIVE_HOST_UNAVAILABLE'
  | 'HANDSHAKE_FAILED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'CANCELLED';

export class GptppNativeError extends Error {
  constructor(
    public readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GptppNativeError';
  }
}

export function nativeUnavailable(reason?: string): GptppNativeError {
  return new GptppNativeError(
    'NATIVE_HOST_UNAVAILABLE',
    reason ?? 'GPT++ Native Host is unavailable.',
  );
}
