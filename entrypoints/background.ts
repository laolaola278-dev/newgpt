/**
 * GPT++ background service worker (MV3).
 *
 * Responsibilities:
 *  - open the Side Panel when the toolbar action is clicked
 *  - log content-script presence announcements from chatgpt.com tabs
 *  - Agent Runtime executor (`tool_execute`): registry → schema → permission
 *    → execution. Native tools route through the capability layer
 *    (Chrome Native Messaging → gptpp-native Rust host); local tools stay in
 *    the worker. Page code never runs capabilities itself.
 */

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isChatGptUrl } from '@/lib/chatgpt-detect';
import { createError, createSuccess, isRequest } from '@/lib/protocol';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultRegistry } from '@/lib/agent/tools/registry';
import type { ExecutorReply, NativeBridge, ToolError } from '@/lib/agent/tools/types';
import { GptppNativeError, type NativeErrorCode } from '@/lib/native/errors';
import { NativeMessagingClient } from '@/lib/native/client';

export default defineBackground(() => {
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[GPT++] sidePanel behavior failed', err));

  // ── Native Messaging (capability layer) ──────────────────────────────────
  const nativeClient = new NativeMessagingClient({
    portFactory: () => browser.runtime.connectNative('com.gptpp.native'),
  });

  let lastConnectAttempt = 0;
  async function ensureNativeConnected(): Promise<boolean> {
    if (nativeClient.isConnected()) return true;
    const now = Date.now();
    if (now - lastConnectAttempt < 5000) return nativeClient.isConnected();
    lastConnectAttempt = now;
    try {
      await nativeClient.connect();
      console.log('[GPT++] native host connected', nativeClient.getCapabilities());
    } catch (err) {
      console.warn('[GPT++] native host unavailable:', (err as Error).message);
    }
    return nativeClient.isConnected();
  }

  function mapNativeError(err: unknown): ToolError {
    if (err instanceof GptppNativeError) {
      const code: NativeErrorCode = err.code;
      if (code === 'TIMEOUT') return { code: 'TIMEOUT', message: err.message };
      if (code === 'NATIVE_HOST_UNAVAILABLE') {
        return { code: 'NATIVE_HOST_UNAVAILABLE', message: err.message };
      }
      return { code: 'TOOL_ERROR', message: `native: ${err.message}` };
    }
    return {
      code: 'TOOL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const nativeBridge: NativeBridge = {
    async execute(toolName, args): Promise<ExecutorReply> {
      const connected = await ensureNativeConnected();
      if (!connected) {
        return {
          status: 'error',
          error: {
            code: 'NATIVE_HOST_UNAVAILABLE',
            message: 'GPT++ Native Host is unavailable.',
          },
        };
      }
      const startedAt = Date.now();
      try {
        const res = await nativeClient.request(toolName, args);
        return {
          status: 'ok',
          result: res.result,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return { status: 'error', error: mapNativeError(err) };
      }
    },
  };

  const executor = createToolExecutor({
    registry: defaultRegistry,
    nativeBridge,
    toolTimeoutMs: 10_000,
  });

  // ── RPC surface ───────────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((message: unknown, _sender): Promise<unknown> | undefined => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'gptpp/hello'
    ) {
      const url = (_sender as { tab?: { url?: string } }).tab?.url;
      if (url && isChatGptUrl(url)) {
        console.log(`[GPT++] content script active on ${url}`);
      }
      return undefined;
    }

    if (!isRequest(message)) return undefined;

    if (message.method === 'tool_execute') {
      return executor(message.params as never)
        .then((reply) => createSuccess(message.id, reply))
        .catch((err: unknown) =>
          createError(
            message.id,
            'RUNTIME_ERROR',
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    if (message.method === 'native_status') {
      // Probe lazily so the panel sees a real state without spamming Chrome.
      void ensureNativeConnected();
      const caps = nativeClient.getCapabilities();
      return Promise.resolve(
        createSuccess(message.id, {
          state: nativeClient.getState(),
          reason: nativeClient.getLastErrorCode(),
          version: caps?.version ?? null,
          protocolVersion: caps?.protocolVersion ?? null,
          capabilities: caps?.capabilities ?? [],
        }),
      );
    }

    // Other methods are handled by their senders (content script).
    return undefined;
  });
});
