/**
 * GPT++ Side Panel — live runtime inspector & control surface.
 *
 * Reports:
 *  - active ChatGPT tab connection, conversation title/id & streaming state
 *  - Agent Loop state machine, step counter, cancel/resume controls & last run
 *  - Native Host (`com.gptpp.native`) handshake status, version & capabilities
 *  - Registered tools across local / native boundaries + permission policy
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
  hostName?: string;
  state: string;
  reason: string | null;
  version: string | null;
  protocolVersion: number | null;
  capabilities: string[];
}

interface RegisteredToolInfo {
  name: string;
  description: string;
  risk: 'safe' | 'low' | 'read' | 'write' | 'execute';
  execution: 'local' | 'native';
}

interface PanelState {
  status: 'checking' | 'connected' | 'disconnected';
  tabId?: number;
  url?: string;
  conversation?: ConversationStatus;
  agent?: AgentStatus;
  native?: NativeHostStatus;
  tools: RegisteredToolInfo[];
}

async function queryRuntime<T>(method: string): Promise<T | undefined> {
  try {
    const raw: unknown = await browser.runtime.sendMessage(createRequest(method));
    return isResponse(raw) && raw.ok ? (raw.result as T) : undefined;
  } catch {
    return undefined;
  }
}

export function App() {
  const [conn, setConn] = useState<PanelState>({
    status: 'checking',
    tools: [],
  });
  const [reconnecting, setReconnecting] = useState(false);

  const check = useCallback(async () => {
    const [tabs, native, toolsRes] = await Promise.all([
      browser.tabs.query({ url: CHATGPT_MATCH_PATTERNS }).catch(() => []),
      queryRuntime<NativeHostStatus>('native_status'),
      queryRuntime<{ tools: RegisteredToolInfo[] }>('tools_list'),
    ]);

    const tools = toolsRes?.tools ?? [];
    // Always prioritize the currently active ChatGPT tab over background tabs.
    const orderedTabs = [...tabs].sort(
      (a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)),
    );

    for (const tab of orderedTabs) {
      if (tab.id === undefined) continue;
      try {
        const res = await requestTab(tab.id, 'ping');
        if (res.ok) {
          const [st, ag] = await Promise.all([
            requestTab(tab.id, 'status').catch(() => null),
            requestTab(tab.id, 'agent_status').catch(() => null),
          ]);
          setConn({
            status: 'connected',
            tabId: tab.id,
            url: tab.url,
            conversation: st?.ok ? (st.result as ConversationStatus) : undefined,
            agent: ag?.ok ? (ag.result as AgentStatus) : undefined,
            native,
            tools,
          });
          return;
        }
      } catch {
        // Content script not ready on this tab; try the next one.
      }
    }

    setConn({ status: 'disconnected', native, tools });
  }, []);

  useEffect(() => {
    void check();
    const poll = setInterval(() => void check(), 2500);

    const onUpdated = (
      _tabId: number,
      change: { status?: string },
      tab: { url?: string },
    ) => {
      if (change.status === 'complete' && isChatGptUrl(tab.url)) void check();
    };
    const onRemoved = () => void check();
    const onActivated = () => void check();

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.onActivated.addListener(onActivated);

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
      browser.tabs.onActivated.removeListener(onActivated);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [check]);

  const handleCancel = async () => {
    if (conn.tabId === undefined) return;
    await requestTab(conn.tabId, 'agent_cancel').catch(() => null);
    await check();
  };

  const handleResume = async () => {
    if (conn.tabId === undefined) return;
    await requestTab(conn.tabId, 'agent_start').catch(() => null);
    await check();
  };

  const handleReconnectNative = async () => {
    setReconnecting(true);
    try {
      const native = await queryRuntime<NativeHostStatus>('native_reconnect');
      setConn((prev) => ({ ...prev, native: native ?? prev.native }));
    } finally {
      setReconnecting(false);
    }
  };

  const version = browser.runtime.getManifest().version;
  const agentBusy =
    conn.agent !== undefined &&
    ['TOOL_DETECTED', 'WAITING_PERMISSION', 'EXECUTING', 'INJECTING_RESULT', 'CONTINUING'].includes(
      conn.agent.state,
    );

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-200 antialiased selection:bg-sky-500/30">
      <div className="mx-auto flex min-h-screen max-w-md flex-col gap-3.5 p-4">
        {/* Top Bar */}
        <header className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-sky-400/25 bg-gradient-to-br from-slate-900 to-sky-950 text-sky-300 shadow-inner">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M11.6 1.8 4.8 11h4.4l-.8 7.2 6.8-9.2h-4.4l.8-7.2Z" />
              </svg>
            </span>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-bold tracking-tight text-slate-100">
                  GPT<span className="text-sky-400">++</span>
                </h1>
                <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  v{version}
                </span>
              </div>
              <p className="text-[10px] text-slate-500">Local Coding Agent Runtime</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void browser.runtime.openOptionsPage()}
            title="Open Workspace Options"
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-white/[0.16] hover:bg-white/[0.06]"
          >
            Options
          </button>
        </header>

        {/* Connection Card */}
        <section className="rounded-xl border border-white/[0.08] bg-[#0f1624] p-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Session Link
            </h2>
            {conn.url && (
              <span className="font-mono text-[10px] text-slate-500">
                {new URL(conn.url).hostname}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <StatusDot
              ok={conn.status === 'connected'}
              pulse={conn.status !== 'disconnected'}
            />
            <span
              className={`text-xs font-medium ${
                conn.status === 'connected' ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              {conn.status === 'connected'
                ? 'Connected to ChatGPT Web'
                : conn.status === 'checking'
                  ? 'Probing active tabs…'
                  : 'No active ChatGPT tab'}
            </span>
          </div>

          {conn.conversation && (
            <div className="mt-2.5 space-y-1.5 border-t border-white/[0.06] pt-2.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-slate-200">
                  {conn.conversation.title ?? 'Untitled conversation'}
                </span>
                {conn.conversation.streaming && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-400/25 bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-sky-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                    streaming
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
                <span>
                  {conn.conversation.messageCount} message
                  {conn.conversation.messageCount === 1 ? '' : 's'}
                </span>
                {conn.conversation.conversationId && (
                  <span>#{conn.conversation.conversationId.slice(0, 8)}</span>
                )}
              </div>
            </div>
          )}

          {conn.status === 'disconnected' && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Open{' '}
              <a
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 underline-offset-2 hover:underline"
              >
                chatgpt.com
              </a>{' '}
              to attach the DOM adapter and agent loop.
            </p>
          )}
        </section>

        {/* Agent Loop Card */}
        <section className="rounded-xl border border-white/[0.08] bg-[#0f1624] p-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Agent Loop
            </h2>
            <div className="flex items-center gap-1.5">
              {conn.agent?.state === 'CANCELLED' && (
                <button
                  type="button"
                  onClick={() => void handleResume()}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  Resume
                </button>
              )}
              {conn.agent &&
                conn.agent.state !== 'IDLE' &&
                conn.agent.state !== 'COMPLETED' &&
                conn.agent.state !== 'CANCELLED' &&
                conn.agent.state !== 'FAILED' && (
                  <button
                    type="button"
                    onClick={() => void handleCancel()}
                    className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300 transition hover:bg-rose-500/20"
                  >
                    Cancel
                  </button>
                )}
            </div>
          </div>

          {conn.agent ? (
            <div className="space-y-2.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      agentBusy
                        ? 'animate-pulse bg-sky-400'
                        : conn.agent.state === 'FAILED'
                          ? 'bg-rose-400'
                          : conn.agent.state === 'COMPLETED'
                            ? 'bg-emerald-400'
                            : 'bg-slate-400'
                    }`}
                  />
                  <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-100">
                    {conn.agent.state}
                  </span>
                </span>
                <span className="font-mono text-[10px] tabular-nums text-slate-400">
                  {conn.agent.steps} step{conn.agent.steps === 1 ? '' : 's'}
                  {conn.agent.queuedCalls > 0 ? ` · ${conn.agent.queuedCalls} queued` : ''}
                </span>
              </div>

              {conn.agent.lastTool && (
                <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-[#090d16] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-semibold text-sky-300">
                      {conn.agent.lastTool.toolName}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-slate-500">
                      {conn.agent.lastTool.durationMs !== null
                        ? `${conn.agent.lastTool.durationMs} ms`
                        : conn.agent.lastTool.errorCode}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-mono text-slate-500">
                      {conn.agent.lastTool.callId}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 font-medium ${
                        conn.agent.lastTool.ok ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {conn.agent.lastTool.ok ? (
                        <>
                          <CheckIcon />
                          <span>Injected</span>
                        </>
                      ) : (
                        <span>Failed · {conn.agent.lastTool.errorCode ?? 'ERROR'}</span>
                      )}
                    </span>
                  </div>
                  {conn.agent.lastTool.resultPreview && (
                    <pre className="max-h-20 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded border border-white/[0.05] bg-[#0d1320] p-2 font-mono text-[10px] leading-relaxed text-slate-300">
                      {conn.agent.lastTool.resultPreview}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Waiting for a ChatGPT session.</p>
          )}
        </section>

        {/* Native Host Card */}
        <section className="rounded-xl border border-white/[0.08] bg-[#0f1624] p-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Native Host (Rust)
            </h2>
            <button
              type="button"
              onClick={() => void handleReconnectNative()}
              disabled={reconnecting}
              className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-slate-400 transition hover:text-slate-200 disabled:opacity-50"
            >
              {reconnecting ? 'Probing…' : 'Reconnect'}
            </button>
          </div>

          {conn.native ? (
            <div className="space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot
                    ok={conn.native.state === 'CONNECTED'}
                    pulse={conn.native.state === 'CONNECTING'}
                  />
                  <span
                    className={`text-xs font-medium ${
                      conn.native.state === 'CONNECTED'
                        ? 'text-emerald-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {conn.native.state === 'CONNECTED'
                      ? 'Connected'
                      : conn.native.state === 'CONNECTING'
                        ? 'Handshaking…'
                        : 'Disconnected'}
                  </span>
                </div>
                {conn.native.version && (
                  <span className="font-mono text-[10px] text-slate-400">
                    v{conn.native.version} · proto v{conn.native.protocolVersion ?? 1}
                  </span>
                )}
              </div>

              {conn.native.hostName && (
                <p className="pl-[18px] font-mono text-[10px] text-slate-500">
                  {conn.native.hostName}
                </p>
              )}

              {conn.native.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pl-[18px]">
                  {conn.native.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="inline-flex items-center gap-1 rounded border border-sky-400/20 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300"
                    >
                      <CheckIcon />
                      <span>{cap}</span>
                    </span>
                  ))}
                </div>
              )}

              {conn.native.reason && conn.native.state !== 'CONNECTED' && (
                <p className="pl-[18px] font-mono text-[10px] text-amber-300/80">
                  {conn.native.reason}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Probing Native Messaging bridge…</p>
          )}
        </section>

        {/* Capability Registry Card */}
        <section className="rounded-xl border border-white/[0.08] bg-[#0f1624] p-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Tool Registry
            </h2>
            <span className="font-mono text-[10px] text-slate-500">
              {conn.tools.length} active
            </span>
          </div>

          {conn.tools.length > 0 ? (
            <div className="divide-y divide-white/[0.05]">
              {conn.tools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] font-medium text-slate-200">
                      {tool.name}
                    </p>
                    <p className="truncate text-[10px] text-slate-500">
                      {tool.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] uppercase text-slate-400">
                      {tool.execution}
                    </span>
                    <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-emerald-300">
                      {tool.risk}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Loading tool definitions…</p>
          )}
        </section>

        <footer className="mt-auto pt-1 text-center text-[10px] text-slate-600">
          On-device execution only · Zero cloud telemetry
        </footer>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3 w-3 shrink-0">
      <path strokeLinecap="round" strokeLinejoin="round" d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

function StatusDot({ ok, pulse }: { ok: boolean; pulse: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
            ok ? 'bg-emerald-400' : 'bg-sky-400'
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
}
