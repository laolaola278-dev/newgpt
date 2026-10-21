/**
 * GPT++ content script — runs inside chatgpt.com pages.
 *
 * Responsibilities:
 *  - instantiate the ChatGPTAdapter (the only DOM interface GPT++ uses)
 *  - coordinate the AgentLoopController with background runtime execution
 *  - answer RPC requests from the side panel / background
 *  - render a closed Shadow DOM status pill reflecting live agent state
 *
 * Everything the page says is untrusted data: tool execution stays isolated
 * in the background service worker and native host process.
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
    for (const evt of [
      'state-changed',
      'tool-started',
      'tool-finished',
      'duplicate-blocked',
      'limit-reached',
      'turn-completed',
    ] as const) {
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
      host.style.cssText = 'all:initial;position:fixed;left:14px;bottom:14px;z-index:2147483646;';
      const shadow = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        .pill {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 5px 11px;
          border-radius: 9999px;
          background: rgba(9, 13, 22, 0.92);
          backdrop-filter: blur(8px);
          color: #e2e8f0;
          border: 1px solid rgba(56, 189, 248, 0.24);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.36);
          font: 600 11px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
          letter-spacing: 0.01em;
          cursor: default;
          user-select: none;
        }
        .dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: #34d399;
          box-shadow: 0 0 8px rgba(52, 211, 153, 0.7);
          flex: none;
        }
        .dot[data-busy="true"] {
          background: #38bdf8;
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.85);
        }
        .brand {
          color: #7dd3fc;
          font-weight: 700;
        }
        .meta {
          color: #94a3b8;
          font-weight: 500;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
        }
      `;

      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.title = `GPT++ v${version} active on ChatGPT`;

      const dot = document.createElement('span');
      dot.className = 'dot';

      const brand = document.createElement('span');
      brand.className = 'brand';
      brand.style.display = 'inline-flex';
      brand.style.alignItems = 'center';
      brand.style.gap = '4px';
      brand.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" style="flex:none"><path d="M11.6 1.8 4.8 11h4.4l-.8 7.2 6.8-9.2h-4.4l.8-7.2Z"/></svg><span>GPT++</span>';

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = 'ready';

      const syncBadge = () => {
        const snap = agent.snapshot();
        const busy =
          snap.state === 'TOOL_DETECTED' ||
          snap.state === 'WAITING_PERMISSION' ||
          snap.state === 'EXECUTING' ||
          snap.state === 'INJECTING_RESULT';
        dot.dataset.busy = busy ? 'true' : 'false';
        if (busy) {
          meta.textContent = snap.lastTool ? `running · ${snap.lastTool.toolName}` : snap.state.toLowerCase();
        } else if (snap.state === 'COMPLETED' && snap.steps > 0) {
          meta.textContent = `done · ${snap.steps} step${snap.steps === 1 ? '' : 's'}`;
        } else if (snap.state === 'CANCELLED') {
          meta.textContent = 'paused';
        } else {
          meta.textContent = 'ready';
        }
      };

      agent.on('state-changed', syncBadge);
      agent.on('tool-finished', syncBadge);

      pill.append(dot, brand, meta);
      shadow.append(style, pill);
      document.body.appendChild(host);
    } catch {
      // Badge is cosmetic; observation works without it.
    }

    console.log(`[GPT++] v${version} injected`);
  },
});
