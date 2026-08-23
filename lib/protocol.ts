/**
 * GPT++ internal RPC envelope.
 *
 * Every message crossing a boundary (content script <-> background, later
 * extension <-> native host) uses the same shape:
 *
 *   request  : { id, method, params? }
 *   response : { id, ok: true, result } | { id, ok: false, error }
 *
 * Keeping one envelope now means the native-messaging protocol in Phase 3
 * reuses this file unchanged.
 */

let seq = 0;

export function createRequestId(): string {
  seq += 1;
  return `req_${Date.now().toString(36)}_${seq}`;
}

export interface GptppRequest<P = unknown> {
  id: string;
  method: string;
  params?: P;
}

export interface GptppSuccess<R = unknown> {
  id: string;
  ok: true;
  result: R;
}

export interface GptppError {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export type GptppResponse<R = unknown> = GptppSuccess<R> | GptppError;

export function createRequest<P>(method: string, params?: P): GptppRequest<P> {
  const req: GptppRequest<P> = { id: createRequestId(), method };
  if (params !== undefined) req.params = params;
  return req;
}

export function createSuccess<R>(id: string, result: R): GptppSuccess<R> {
  return { id, ok: true, result };
}

export function createError(id: string, code: string, message: string): GptppError {
  return { id, ok: false, error: { code, message } };
}

export function isRequest(value: unknown): value is GptppRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.method === 'string';
}

export function isResponse(value: unknown): value is GptppResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (v.ok === true) return 'result' in v;
  if (v.ok === false) {
    const err = v.error as Record<string, unknown> | undefined;
    return (
      typeof err === 'object' &&
      err !== null &&
      typeof err.code === 'string' &&
      typeof err.message === 'string'
    );
  }
  return false;
}
