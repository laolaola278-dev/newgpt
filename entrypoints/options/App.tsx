/**
 * GPT++ Options — workspace boundary, 5-scope permission matrix & native host diagnostics.
 */

import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ALL_PERMISSION_SCOPES,
  DEFAULT_SCOPE_POLICY,
  type PermissionDecision,
  type PermissionSnapshot,
  type ScopePolicyMap,
} from '@/lib/agent/permission';
import type { PermissionScope } from '@/lib/agent/tools/types';
import { createRequest, isResponse } from '@/lib/protocol';

const WORKSPACE_KEY = 'workspace.root';

const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  READ: 'Read workspace files, list directories & search code',
  WRITE: 'Create or modify files inside the confined workspace',
  EXECUTE: 'Run controlled shell commands & local MCP servers',
  GIT: 'Inspect repository status/diff/log & stage/commit changes',
  BROWSER: 'Inspect open tab titles/URLs & active page metadata',
};

interface NativeHostStatus {
  hostName?: string;
  state: string;
  reason: string | null;
  version: string | null;
  protocolVersion: number | null;
  capabilities: string[];
}

export function App() {
  const [root, setRoot] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [native, setNative] = useState<NativeHostStatus | null>(null);
  const [policy, setPolicy] = useState<ScopePolicyMap>({ ...DEFAULT_SCOPE_POLICY });
  const [probing, setProbing] = useState(false);

  const probeNative = useCallback(async (force = false) => {
    setProbing(true);
    try {
      const raw: unknown = await browser.runtime.sendMessage(
        createRequest(force ? 'native_reconnect' : 'native_status'),
      );
      if (isResponse(raw) && raw.ok) {
        setNative(raw.result as NativeHostStatus);
      }
    } catch {
      /* ignore when outside extension context */
    } finally {
      setProbing(false);
    }
  }, []);

  const loadPermissions = useCallback(async () => {
    try {
      const raw: unknown = await browser.runtime.sendMessage(
        createRequest('permissions_state'),
      );
      if (isResponse(raw) && raw.ok) {
        setPolicy((raw.result as PermissionSnapshot).policy);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void browser.storage.local
      .get(WORKSPACE_KEY)
      .then((items) => {
        const v = items[WORKSPACE_KEY];
        if (typeof v === 'string') setRoot(v);
      })
      .finally(() => setLoaded(true));
    void probeNative(false);
    void loadPermissions();
  }, [probeNative, loadPermissions]);

  const save = async () => {
    const trimmed = root.trim();
    setRoot(trimmed);
    await browser.storage.local.set({ [WORKSPACE_KEY]: trimmed });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const updateScope = async (scope: PermissionScope, decision: PermissionDecision) => {
    setPolicy((prev) => ({ ...prev, [scope]: decision }));
    try {
      const raw: unknown = await browser.runtime.sendMessage(
        createRequest('permissions_set_scope', { scope, decision }),
      );
      if (isResponse(raw) && raw.ok) {
        setPolicy((raw.result as PermissionSnapshot).policy);
      }
    } catch {
      /* ignore */
    }
  };

  const version = browser.runtime.getManifest().version;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-200 antialiased">
      <div className="mx-auto max-w-2xl px-8 py-10">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-white/[0.08] pb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-sky-400/25 bg-gradient-to-br from-slate-900 to-sky-950 text-sky-300">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path d="M11.6 1.8 4.8 11h4.4l-.8 7.2 6.8-9.2h-4.4l.8-7.2Z" />
              </svg>
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-slate-100">
                  GPT<span className="text-sky-400">++</span> Settings
                </h1>
                <span className="rounded border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-slate-400">
                  v{version}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Workspace confinement, 5-scope permission matrix & Native Host bridge
              </p>
            </div>
          </div>
          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] text-emerald-300">
            Local-First · MV3
          </span>
        </header>

        {/* Workspace Confinement */}
        <section className="mt-6 rounded-2xl border border-white/[0.08] bg-[#0f1624] p-5">
          <div>
            <label
              htmlFor="workspace-root"
              className="block text-sm font-semibold text-slate-100"
            >
              Workspace Confinement Root
            </label>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Absolute directory boundary that local filesystem, git, and shell tools
              may access. Path traversal outside this root is strictly rejected.
            </p>
          </div>

          <div className="mt-4 flex gap-2.5">
            <input
              id="workspace-root"
              type="text"
              value={root}
              placeholder="/Users/dev/workspace/my-project  or  D:\workspace\my-project"
              onChange={(e) => {
                setRoot(e.target.value);
                setSaved(false);
              }}
              disabled={!loaded}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-white/[0.1] bg-[#090d16] px-3.5 py-2.5 font-mono text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!loaded}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-sky-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 active:scale-[0.98] disabled:opacity-50"
            >
              {saved ? (
                <>
                  <span>Saved</span>
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    className="h-3.5 w-3.5"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="m3 8.5 3.2 3.2L13 5" />
                  </svg>
                </>
              ) : (
                'Save Path'
              )}
            </button>
          </div>
        </section>

        {/* Granular 5-Scope Permission Matrix */}
        <section className="mt-5 rounded-2xl border border-white/[0.08] bg-[#0f1624] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Granular Permission Matrix
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Control default behavior per capability scope (Ask prompts inside the Side Panel)
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                void browser.runtime
                  .sendMessage(createRequest('permissions_reset_session'))
                  .then(() => loadPermissions())
              }
              className="shrink-0 whitespace-nowrap rounded-xl border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/[0.08]"
            >
              Reset Session Grants
            </button>
          </div>

          <div className="mt-4 divide-y divide-white/[0.06] rounded-xl border border-white/[0.06] bg-[#090d16] px-4">
            {ALL_PERMISSION_SCOPES.map((scope) => (
              <div
                key={scope}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <span className="font-mono text-xs font-bold text-sky-300">
                    {scope}
                  </span>
                  <p className="mt-0.5 truncate text-xs text-slate-400">
                    {SCOPE_DESCRIPTIONS[scope]}
                  </p>
                </div>

                <div className="flex shrink-0 rounded-lg border border-white/[0.08] bg-[#0f1624] p-0.5 text-xs">
                  {(['allow', 'ask', 'deny'] as const).map((mode) => {
                    const active = policy[scope] === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => void updateScope(scope, mode)}
                        className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-medium uppercase transition ${
                          active
                            ? mode === 'allow'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : mode === 'deny'
                                ? 'bg-rose-500/20 text-rose-300'
                                : 'bg-amber-500/20 text-amber-200'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        {mode}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Native Host Bridge Status */}
        <section className="mt-5 rounded-2xl border border-white/[0.08] bg-[#0f1624] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Chrome Native Messaging Bridge
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Rust host binary (<code className="font-mono text-sky-300">com.gptpp.native</code>) speaking length-prefixed JSON RPC v1
              </p>
            </div>
            <button
              type="button"
              onClick={() => void probeNative(true)}
              disabled={probing}
              className="shrink-0 whitespace-nowrap rounded-xl border border-white/[0.1] bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              {probing ? 'Checking…' : 'Test Connection'}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl border border-white/[0.06] bg-[#090d16] p-3.5 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Status</p>
              <p
                className={`mt-1 font-mono font-semibold ${
                  native?.state === 'CONNECTED' ? 'text-emerald-400' : 'text-amber-300'
                }`}
              >
                {native?.state ?? 'CHECKING'}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Protocol</p>
              <p className="mt-1 font-mono text-slate-200">
                {native?.version
                  ? `v${native.version} (RPC v1)`
                  : 'v1 (stdio)'}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Capabilities</p>
              <p className="mt-1 truncate font-mono text-sky-300">
                {native?.capabilities.length
                  ? `${native.capabilities.length} registered`
                  : 'native_echo'}
              </p>
            </div>
          </div>
        </section>

        <footer className="mt-6 flex items-center justify-between text-xs text-slate-500">
          <span>All settings persist locally in chrome.storage.local.</span>
          <span className="font-mono text-[11px] text-slate-600">Zero external servers</span>
        </footer>
      </div>
    </div>
  );
}
