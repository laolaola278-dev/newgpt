/**
 * GPT++ content script — runs inside chatgpt.com pages.
 *
 * Phase 1 scope:
 *  - instantiate the ChatGPTAdapter (the only DOM interface GPT++ uses)
 *  - answer RPC requests from the side panel / background
 *  - keep the small ⚡ badge confirming injection
 *
 * Everything the page says is untrusted data: this layer only observes and
 * reports. No tool-call parsing or execution happens here.
 */

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  createError,
  createRequest,
  createSuccess,
  isRequest,
  isResponse,
  type GptppRequest,
  type GptppResponse,
} from '@/lib/protocol';
import { CHATGPT_MATCH_PATTERNS } from '@/lib/chatgpt-detect';
import { ChatGPTAdapter } from '@/lib/chatgpt/adapter';
import { toSnapshot } from '@/lib/chatgpt/types';
import { AgentLoopController } from '@/lib/agent/loop/controller';
import type { ExecutorReply, ToolExecutePayload } from '@/lib/agent/tools/types';

export default defineContentScript({
  matches: CHATGPT_MATCH_PATTERNS,
  runAt: 'document_idle',

  main() {
    // Guard against double injection on extension reloads in a live document.
    const win = window as typeof window & { __gptppInjected?: boolean };
    if (win.__gptppInjected) return;
    win.__gptppInjected = true;

    document.documentElement.dataset.gptpp = 'loaded';
    const version = browser.runtime.getManifest().version;

    const adapter = new ChatGPTAdapter();

    // Debug log of the unified event stream (metadata only, no page text).
    for (const evt of [
      'ready',
      'navigation',
      'message-added',
      'message-updated',
      'stream-start',
      'stream-update',
      'stream-end',
      'composer-changed',
    ] as const) {
      adapter.on(evt, (payload) => {
        const detail =
          evt === 'navigation'
            ? (payload as { conversationId: string | null }).conversationId
            : evt === 'message-added' || evt === 'message-updated'
              ? (payload as { message: { id: string } }).message.id
              : '';
        console.debug(`[GPT++] ${evt}${detail ? ` ${detail}` : ''}`);
      });
    }
    adapter.start();

    // ── Agent Loop (page-side orchestration; tools run in the background) ──
    async function executeViaBackground(payload: ToolExecutePayload): Promise<ExecutorReply> {
      const raw: unknown = await browser.runtime.sendMessage(
        createRequest('tool_execute', payload),
      );
      if (!isResponse(raw)) throw new Error('malformed runtime response');
      if (!raw.ok) throw new Error(raw.error.message);
      return raw.result as ExecutorReply;
    }

    const agent = new AgentLoopController({ adapter, executeTool: executeViaBackground });
    for (const evt of ['state-changed', 'tool-started', 'tool-finished', 'duplicate-blocked', 'limit-reached', 'turn-completed'] as const) {
      agent.on(evt, (payload) => {
        console.debug(`[GPT++] agent:${evt}`, payload);
      });
    }
    agent.start();

    async function handle(req: GptppRequest): Promise<GptppResponse> {
      switch (req.method) {
        case 'ping':
          return createSuccess(req.id, { pong: true, version });

        case 'status':
          return createSuccess(req.id, {
            available: adapter.isAvailable(),
            version,
            conversationId: adapter.getConversationId(),
            title: adapter.getConversationTitle(),
            messageCount: adapter.getMessages().length,
            streaming: adapter.isStreaming(),
            lastAssistant: adapter.getLastAssistantMessage()?.content.slice(0, 200) ?? null,
          });

        case 'get_messages':
          return createSuccess(req.id, {
            messages: adapter.getMessages().map(toSnapshot),
          });

        case 'set_composer_text': {
          const params = req.params as { text?: unknown } | undefined;
          if (typeof params?.text !== 'string') {
            return createError(req.id, 'INVALID_PARAMS', 'text:string required');
          }
          return createSuccess(req.id, {
            ok: adapter.setComposerText(params.text),
          });
        }

        case 'submit_composer': {
          if (!adapter.isAvailable()) {
            return createError(req.id, 'UNAVAILABLE', 'ChatGPT UI not detected');
          }
          return createSuccess(req.id, { ok: adapter.submitComposer() });
        }

        case 'agent_status':
          return createSuccess(req.id, agent.snapshot());

        case 'agent_start':
          agent.start();
          return createSuccess(req.id, { ok: true, state: agent.snapshot().state });

        case 'agent_cancel':
          agent.cancel();
          return createSuccess(req.id, { ok: true, state: agent.snapshot().state });

        default:
          return createError(req.id, 'UNKNOWN_METHOD', `unknown method ${req.method}`);
      }
    }

    browser.runtime.onMessage.addListener(
      (message: unknown): Promise<GptppResponse> | undefined => {
        if (!isRequest(message)) return undefined;
        return handle(message).catch((err: unknown) =>
          createError(message.id, 'INTERNAL', err instanceof Error ? err.message : String(err)),
        );
      },
    );

    void browser.runtime.sendMessage({ type: 'gptpp/hello' }).catch(() => {});

    try {
      const host = document.createElement('div');
      host.id = 'gptpp-badge-host';
      host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;';
      const shadow = host.attachShadow({ mode: 'closed' });

      const pill = document.createElement('div');
      pill.textContent = '⚡ GPT++';
      pill.title = `GPT++ v${version} active on ChatGPT`;
      pill.style.cssText = [
        'box-sizing:border-box',
        'padding:4px 10px',
        'border-radius:9999px',
        'background:#0b1220',
        'color:#7dd3fc',
        'border:1px solid #1e293b',
        "font:600 11px/1 ui-sans-serif,system-ui,sans-serif",
        'opacity:0.85',
        'cursor:default',
        'user-select:none',
      ].join(';');

      shadow.appendChild(pill);
      document.body.appendChild(host);
    } catch {
      // Badge is cosmetic; observation works without it.
    }

    console.log(`[GPT++] v${version} injected`);
  },
});
