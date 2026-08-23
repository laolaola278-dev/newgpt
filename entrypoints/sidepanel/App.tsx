/**
 * GPT++ Side Panel — Phase 1.
 *
 * Shows whether the extension is alive and injected into a ChatGPT tab,
 * plus live conversation state reported by the ChatGPTAdapter.
 * Agent task list / tool feed are wired in later phases.
 */

import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CHATGPT_MATCH_PATTERNS, isChatGptUrl } from '@/lib/chatgpt-detect';
import { requestTab } from '@/lib/messaging';
import { createRequest, isResponse } from '@/lib/protocol';

interface ConversationStatus {
  conversationId: string | null;
  title: string | null;
  messageCount: number;
  streaming: boolean;
}

interface AgentStatus {
  state: string;
  steps: number;
  queuedCalls: number;
  lastTool: {
    callId: string;
    toolName: string;
    ok: boolean;
    durationMs: number | null;
    errorCode?: string;
    resultPreview?: string;
  } | null;
}

interface NativeHostStatus {
  state: string;
  reason: string | null;
  version: string | null;
  protocolVersion: number | null;
  capabilities: string[];
}

interface ConnectionState {
  status: 'checking' | 'connected' | 'disconnected';
  url?: string;
  conversation?: ConversationStatus;
  agent?: AgentStatus;
  native?: NativeHostStatus;
}

function useChatGptConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ status: 'checking' });

  const check = useCallback(async () => {
    const tabs = await browser.tabs.query({ url: CHATGPT_MATCH_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const res = await requestTab(tab.id, 'ping');
        if (res.ok) {
          let conversation: ConversationStatus | undefined;
          let agent: AgentStatus | undefined;
          const st = await requestTab(tab.id, 'status').catch(() => null);
          if (st?.ok) conversation = st.result as ConversationStatus;
          const ag = await requestTab(tab.id, 'agent_status').catch(() => null);
          if (ag?.ok) agent = ag.result as AgentStatus;
          const nv = await browser.runtime
            .sendMessage(createRequest('native_status'))
            .then((r: unknown) => (isResponse(r) && r.ok ? (r.result as NativeHostStatus) : undefined))
            .catch(() => undefined);
          setState({ status: 'connected', url: tab.url, conversation, agent, native: nv });
          return;
        }
      } catch {
        // content script not ready on this tab; try the next one
      }
    }
    setState({ status: 'disconnected' });
  }, []);

  useEffect(() => {
    void check();
    const poll = setInterval(() => void check(), 4000);

    const onUpdated = (
      _tabId: number,
      change: { status?: string },
      tab: { url?: string },
    ) => {
      if (change.status === 'complete' && isChatGptUrl(tab.url)) void check();
    };
    const onRemoved = () => void check();
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);

    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'gptpp/hello'
      ) {
        void check();
      }
    };
    browser.runtime.onMessage.addListener(onMessage);

    return () => {
      clearInterval(poll);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [check]);

  return state;
}

const StatusDot = ({ ok, pulse }: { ok: boolean; pulse: boolean }) => (
  <span className="relative flex h-2.5 w-2.5">
    {pulse && (
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
          ok ? 'bg-emerald-400' : 'bg-slate-500'
        }`}
      />
    )}
    <span
      className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
        ok ? 'bg-emerald-400' : 'bg-slate-600'
      }`}
    />
  </span>
);

export function App() {
  const conn = useChatGptConnection();
  const version = browser.runtime.getManifest().version;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 antialiased">
      <div className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
        {/* Header */}
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold tracking-tight text-sky-300">
            GPT<span className="text-slate-100">++</span>
          </h1>
          <span className="rounded-full border border-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
            v{version}
          </span>
        </header>

        {/* Connection */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Connection
          </h2>
          <div className="flex items-center gap-2">
            <StatusDot
              ok={conn.status === 'connected'}
              pulse={conn.status !== 'disconnected'}
            />
            <span
              className={
                conn.status === 'connected'
                  ? 'font-medium text-emerald-400'
                  : conn.status === 'checking'
                    ? 'text-slate-400'
                    : 'text-slate-400'
              }
            >
              {conn.status === 'connected'
                ? 'Connected to ChatGPT'
                : conn.status === 'checking'
                  ? 'Checking…'
                  : 'No ChatGPT tab detected'}
            </span>
          </div>
          {conn.url && (
            <p className="mt-1 truncate pl-[18px] text-[11px] text-slate-500">
              {new URL(conn.url).hostname}
            </p>
          )}
          {conn.conversation && (
            <div className="mt-2 space-y-1 border-t border-slate-800 pt-2 pl-[18px] text-[11px]">
              <p className="truncate text-slate-300">
                <span className="text-slate-500">Conversation:</span>{' '}
                {conn.conversation.title ?? 'New chat'}
              </p>
              <p className="flex items-center gap-1.5 text-slate-400">
                <span>
                  {conn.conversation.messageCount} message
                  {conn.conversation.messageCount === 1 ? '' : 's'}
                </span>
                {conn.conversation.streaming && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-950 px-2 py-0.5 font-medium text-sky-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                    streaming
                  </span>
                )}
              </p>
            </div>
          )}
          {conn.status === 'disconnected' && (
            <p className="mt-2 pl-[18px] text-[11px] leading-snug text-slate-500">
              Open{' '}
              <a
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:underline"
              >
                chatgpt.com
              </a>{' '}
              and the badge ⚡ GPT++ confirms injection.
            </p>
          )}
        </section>

        {/* Agent status (Phase 2) */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Agent
            </h2>
            {conn.agent && conn.agent.state !== 'IDLE' && conn.agent.state !== 'COMPLETED' && conn.agent.state !== 'CANCELLED' && conn.agent.state !== 'FAILED' && (
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const tabs = await browser.tabs.query({ url: CHATGPT_MATCH_PATTERNS });
                    const tab = tabs.find((t) => t.id !== undefined);
                    if (tab?.id !== undefined) await requestTab(tab.id, 'agent_cancel').catch(() => null);
                  })();
                }}
                className="rounded-md border border-rose-900 px-2 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-950/50"
              >
                Cancel
              </button>
            )}
          </div>
          {conn.agent ? (
            <div className="space-y-1.5 text-[11px]">
              <p className="flex items-center gap-2">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    conn.agent.state === 'EXECUTING' || conn.agent.state === 'TOOL_DETECTED' || conn.agent.state === 'WAITING_PERMISSION' || conn.agent.state === 'INJECTING_RESULT'
                      ? 'animate-pulse bg-sky-400'
                      : conn.agent.state === 'FAILED'
                        ? 'bg-rose-400'
                        : 'bg-slate-500'
                  }`}
                />
                <span className="font-mono font-semibold text-slate-200">{conn.agent.state}</span>
                <span className="text-slate-500">· {conn.agent.steps} step{conn.agent.steps === 1 ? '' : 's'}</span>
              </p>
              {conn.agent.lastTool && (
                <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                  <p className="flex justify-between">
                    <span className="font-mono text-sky-300">{conn.agent.lastTool.toolName}</span>
                    <span className="text-slate-500">{conn.agent.lastTool.durationMs !== null ? `${conn.agent.lastTool.durationMs}ms` : conn.agent.lastTool.errorCode}</span>
                  </p>
                  <p className="font-mono text-[10px] text-slate-500">{conn.agent.lastTool.callId}</p>
                  <p className={conn.agent.lastTool.ok ? 'text-emerald-400' : 'text-rose-400'}>
                    {conn.agent.lastTool.ok ? '✓ Completed' : `✗ ${conn.agent.lastTool.errorCode ?? 'Failed'}`}
                  </p>
                  {conn.agent.lastTool.resultPreview && (
                    <p className="max-h-16 overflow-y-auto break-all rounded bg-slate-900 p-1.5 font-mono text-[10px] text-slate-400">
                      {conn.agent.lastTool.resultPreview}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Agent idle — no ChatGPT tab.</p>
          )}
        </section>

        {/* Native Host (Phase 3) */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Native Host
          </h2>
          {conn.native ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <StatusDot ok={conn.native.state === 'CONNECTED'} pulse={conn.native.state === 'CONNECTING'} />
                <span className={conn.native.state === 'CONNECTED' ? 'font-medium text-emerald-400' : 'text-slate-400'}>
                  {conn.native.state === 'CONNECTED'
                    ? 'Connected'
                    : conn.native.state === 'CONNECTING'
                      ? 'Connecting…'
                      : conn.native.state === 'ERROR'
                        ? 'Error'
                        : 'Disconnected'}
                </span>
                {conn.native.version && (
                  <span className="text-[10px] text-slate-600">v{conn.native.version}</span>
                )}
              </div>
              {conn.native.protocolVersion !== null && (
                <p className="pl-[18px] text-[11px] text-slate-500">Protocol v{conn.native.protocolVersion}</p>
              )}
              {conn.native.capabilities.length > 0 && (
                <p className="flex flex-wrap gap-1 pl-[18px]">
                  {conn.native.capabilities.map((cap) => (
                    <span key={cap} className="rounded bg-sky-950 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                      ✓ {cap}
                    </span>
                  ))}
                </p>
              )}
              {conn.native.reason && conn.native.state !== 'CONNECTED' && (
                <p className="pl-[18px] text-[11px] text-rose-400/80">Reason: {conn.native.reason}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No ChatGPT tab — status unknown.</p>
          )}
        </section>

        {/* Tool executions (populated from Phase 4 onward) */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Tools
          </h2>
          <p className="text-sm text-slate-500">
            Filesystem / shell tools arrive with Phase 4.
          </p>
        </section>

        {/* Permissions (from Phase 5 onward) */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Permissions
          </h2>
          <p className="text-sm text-slate-500">No pending permission requests.</p>
        </section>

        <footer className="mt-auto pt-2 text-center text-[11px] text-slate-600">
          Configure the workspace root in Options before enabling local tools.
        </footer>
      </div>
    </div>
  );
}
