/**
 * GPT++ Options — Phase 0.
 *
 * Only one real setting exists so far: the default workspace root that the
 * Native Host tools (Phase 4+) will operate inside. Stored locally; nothing
 * leaves the machine.
 */

import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

const WORKSPACE_KEY = 'workspace.root';

export function App() {
  const [root, setRoot] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void browser.storage.local
      .get(WORKSPACE_KEY)
      .then((items) => {
        const v = items[WORKSPACE_KEY];
        if (typeof v === 'string') setRoot(v);
      })
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    await browser.storage.local.set({ [WORKSPACE_KEY]: root.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 antialiased">
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-lg font-bold tracking-tight text-sky-300">
          GPT<span className="text-slate-100">++</span> Options
        </h1>

        <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <label
            htmlFor="workspace-root"
            className="block text-sm font-semibold text-slate-300"
          >
            Default workspace root
          </label>
          <p className="mt-1 text-xs leading-snug text-slate-500">
            Absolute path of the folder GPT++ tools may operate in. Filesystem and
            shell tools (Phase 4+) are confined to this directory.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              id="workspace-root"
              type="text"
              value={root}
              placeholder="/home/you/projects or D:\projects"
              onChange={(e) => {
                setRoot(e.target.value);
                setSaved(false);
              }}
              disabled={!loaded}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!loaded}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 active:scale-[0.98] disabled:opacity-50"
            >
              {saved ? 'Saved ✓' : 'Save'}
            </button>
          </div>
        </section>

        <footer className="mt-6 text-xs text-slate-600">
          Settings stay on this device. GPT++ has no cloud backend.
        </footer>
      </div>
    </div>
  );
}
