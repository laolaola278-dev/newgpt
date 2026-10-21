/**
 * Workspace root confinement utilities (extension layer).
 *
 * The extension enforces workspace confinement before forwarding requests to
 * the Native Host, and the Rust Native Host re-verifies every path against
 * the canonicalized directory on disk (defense in depth).
 */

export const WORKSPACE_STORAGE_KEY = 'workspace.root';

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isWindowsDrivePath(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p);
}

/** Validate and normalize a configured workspace root string. */
export function normalizeWorkspaceRoot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  const slashed = normalizeSlashes(trimmed);
  if (!slashed.startsWith('/') && !isWindowsDrivePath(slashed)) {
    return null;
  }

  // Collapse '.' and '..' segments lexically.
  const prefix = isWindowsDrivePath(slashed) ? slashed.slice(0, 2) : '';
  const rest = prefix ? slashed.slice(2) : slashed;
  const parts: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return `${prefix}/${parts.join('/')}`;
}

export type ConfinementResult =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; message: string };

/**
 * Resolve `userPath` relative to `workspaceRoot` and guarantee it never escapes
 * outside `workspaceRoot` (blocking `../`, null bytes, and prefix collisions
 * such as `/work-secret` vs `/work`).
 */
export function resolveWithinWorkspace(
  workspaceRoot: unknown,
  userPath = '.',
): ConfinementResult {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  if (!root) {
    return {
      ok: false,
      message: 'Workspace root is not configured. Set a valid absolute path in GPT++ Options first.',
    };
  }
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    return { ok: false, message: 'Path must be a valid string without null bytes.' };
  }

  const rawTarget = normalizeSlashes(userPath.trim() || '.');
  const isAbs = rawTarget.startsWith('/') || isWindowsDrivePath(rawTarget);
  const combined = isAbs ? rawTarget : `${root}/${rawTarget}`;

  const prefix = isWindowsDrivePath(combined) ? combined.slice(0, 2) : '';
  const rootPrefix = isWindowsDrivePath(root) ? root.slice(0, 2) : '';
  if (prefix.toLowerCase() !== rootPrefix.toLowerCase()) {
    return { ok: false, message: `Path "${userPath}" escapes workspace drive boundary.` };
  }

  const rest = prefix ? combined.slice(2) : combined;
  const resolvedParts: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolvedParts.length === 0) {
        return { ok: false, message: `Path "${userPath}" traverses outside root.` };
      }
      resolvedParts.pop();
    } else {
      resolvedParts.push(seg);
    }
  }

  const candidate = `${rootPrefix}/${resolvedParts.join('/')}`;
  const cmpRoot = rootPrefix ? candidate.toLowerCase() : candidate;
  const cmpBase = rootPrefix ? root.toLowerCase() : root;

  const inside =
    cmpBase === '/'
      ? cmpRoot.startsWith('/')
      : cmpRoot === cmpBase || cmpRoot.startsWith(`${cmpBase}/`);

  if (!inside) {
    return {
      ok: false,
      message: `Access denied: "${userPath}" resolves outside workspace root "${root}".`,
    };
  }

  const rel =
    cmpBase === '/'
      ? candidate.slice(1)
      : candidate.length > root.length
        ? candidate.slice(root.length + 1)
        : '.';

  return {
    ok: true,
    absolutePath: candidate,
    relativePath: rel || '.',
  };
}
