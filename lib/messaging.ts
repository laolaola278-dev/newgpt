/**
 * Typed messaging helpers on top of chrome.runtime / chrome.tabs.
 *
 * The side panel and background talk to the ChatGPT content script through
 * the GPT++ RPC envelope (see ./protocol). Everything is promise-based with
 * an explicit timeout so a dead or reloading tab cannot hang the UI.
 */

import { browser } from 'wxt/browser';
import {
  createError,
  createRequest,
  isResponse,
  type GptppRequest,
  type GptppResponse,
} from './protocol';

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Send an RPC request to a tab's content script and resolve with the
 * response envelope. Rejects on timeout or when no receiver exists.
 */
export async function requestTab<P, R>(
  tabId: number,
  method: string,
  params?: P,
  timeoutMs = 1500,
): Promise<GptppResponse<R>> {
  const req: GptppRequest<P> = createRequest<P>(method, params);
  const raw = await withTimeout(
    browser.tabs.sendMessage<unknown, unknown>(tabId, req) as Promise<unknown>,
    timeoutMs,
  );
  if (isResponse(raw)) return raw as GptppResponse<R>;
  throw new Error('malformed response from content script');
}

/** Build a standard error response for caught exceptions. */
export function errorFrom(id: string, err: unknown): GptppResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  return createError(id, 'INTERNAL', message);
}
