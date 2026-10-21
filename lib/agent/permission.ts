/**
 * Phase 5 — Granular 5-Scope Permission Policy & Interactive Consent Manager.
 *
 * Scopes:
 *   READ | WRITE | EXECUTE | GIT | BROWSER
 *
 * `safe` and `low` tools remain non-privileged utilities allowed by default;
 * every scoped capability passes through explicit policy evaluation, optional
 * session-wide scope grants, and interactive user approval.
 */

import type { PermissionScope, ToolDefinition, ToolRisk } from './tools/types';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type ConsentResolution = 'allow_once' | 'allow_session' | 'deny';

export const ALL_PERMISSION_SCOPES: readonly PermissionScope[] = [
  'READ',
  'WRITE',
  'EXECUTE',
  'GIT',
  'BROWSER',
];

export type ScopePolicyMap = Record<PermissionScope, PermissionDecision>;

export const DEFAULT_SCOPE_POLICY: Readonly<ScopePolicyMap> = {
  READ: 'ask',
  WRITE: 'ask',
  EXECUTE: 'ask',
  GIT: 'ask',
  BROWSER: 'ask',
};

export const PERMISSION_STORAGE_KEY = 'permissions.policy';

export type PermissionPolicy = (
  tool: Pick<ToolDefinition, 'name' | 'risk' | 'scope'>,
) => PermissionDecision;

export function resolveToolScope(
  tool: Pick<ToolDefinition, 'risk' | 'scope'>,
): PermissionScope | null {
  if (tool.scope) return tool.scope;
  switch (tool.risk) {
    case 'safe':
    case 'low':
      return null;
    case 'read':
      return 'READ';
    case 'write':
      return 'WRITE';
    case 'execute':
      return 'EXECUTE';
    case 'git':
      return 'GIT';
    case 'browser':
      return 'BROWSER';
  }
}

/** safe/low → allow, everything scoped → ask. */
export const defaultPermissionPolicy: PermissionPolicy = (tool) =>
  resolveToolScope(tool) === null ? 'allow' : 'ask';

export interface AskResolverContext {
  toolName: string;
  risk: ToolRisk;
  scope?: PermissionScope;
  callId: string;
  argsSummary?: string;
}

export type AskResolver = (ctx: AskResolverContext) => Promise<boolean>;

export const defaultAskResolver: AskResolver = async (ctx) => {
  console.warn(
    `[GPT++] permission ask for "${ctx.toolName}" (${ctx.scope ?? ctx.risk}) denied automatically: no resolver installed`,
  );
  return false;
};

export interface PendingPermissionItem {
  id: string;
  callId: string;
  toolName: string;
  scope: PermissionScope;
  risk: ToolRisk;
  argsSummary: string;
  createdAt: number;
}

export interface PermissionSnapshot {
  policy: ScopePolicyMap;
  sessionGrants: PermissionScope[];
  pending: PendingPermissionItem[];
}

interface PendingWaiter {
  item: PendingPermissionItem;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Summarize argument keys & scalar lengths without logging raw file contents or secrets. */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const compact =
        k === 'content'
          ? `<${v.length} chars>`
          : v.length > 48
            ? `${v.slice(0, 45)}…`
            : v;
      parts.push(`${k}: ${JSON.stringify(compact)}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${String(v)}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}: [${v.length} items]`);
    } else if (v !== null && typeof v === 'object') {
      parts.push(`${k}: {…}`);
    }
  }
  return parts.join(', ') || '{}';
}

export class PermissionManager {
  private policy: ScopePolicyMap = { ...DEFAULT_SCOPE_POLICY };
  private sessionGrants = new Set<PermissionScope>();
  private pending = new Map<string, PendingWaiter>();
  private seq = 0;

  constructor(initialPolicy?: Partial<ScopePolicyMap>) {
    if (initialPolicy) this.replacePolicy(initialPolicy);
  }

  replacePolicy(next: Partial<ScopePolicyMap>): void {
    for (const scope of ALL_PERMISSION_SCOPES) {
      const val = next[scope];
      if (val === 'allow' || val === 'ask' || val === 'deny') {
        this.policy[scope] = val;
      }
    }
  }

  setScopeDecision(scope: PermissionScope, decision: PermissionDecision): ScopePolicyMap {
    if (!ALL_PERMISSION_SCOPES.includes(scope)) return this.getPolicy();
    this.policy[scope] = decision;
    if (decision === 'deny') {
      this.sessionGrants.delete(scope);
    }
    return this.getPolicy();
  }

  getPolicy(): ScopePolicyMap {
    return { ...this.policy };
  }

  resetSessionGrants(): void {
    this.sessionGrants.clear();
  }

  /** Policy function pluggable directly into `createToolExecutor({ policy })`. */
  evaluate = (tool: Pick<ToolDefinition, 'name' | 'risk' | 'scope'>): PermissionDecision => {
    const scope = resolveToolScope(tool);
    if (scope === null) return 'allow';
    const configured = this.policy[scope];
    if (configured === 'deny') return 'deny';
    if (configured === 'allow') return 'allow';
    if (this.sessionGrants.has(scope)) return 'allow';
    return 'ask';
  };

  /** Enqueue an interactive approval prompt and resolve when the user decides or times out. */
  requestApproval(
    input: {
      callId: string;
      toolName: string;
      scope: PermissionScope;
      risk: ToolRisk;
      argsSummary?: string;
    },
    timeoutMs = 90_000,
  ): Promise<boolean> {
    if (this.sessionGrants.has(input.scope) || this.policy[input.scope] === 'allow') {
      return Promise.resolve(true);
    }
    if (this.policy[input.scope] === 'deny') {
      return Promise.resolve(false);
    }

    const id = `perm_${++this.seq}`;
    const item: PendingPermissionItem = {
      id,
      callId: input.callId,
      toolName: input.toolName,
      scope: input.scope,
      risk: input.risk,
      argsSummary: input.argsSummary ?? '{}',
      createdAt: Date.now(),
    };

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pending.set(id, { item, resolve, timer });
    });
  }

  resolvePending(id: string, resolution: ConsentResolution): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);

    if (resolution === 'allow_session') {
      this.sessionGrants.add(entry.item.scope);
      // Also auto-approve any sibling pending requests sharing the same scope.
      for (const [otherId, other] of [...this.pending.entries()]) {
        if (other.item.scope === entry.item.scope) {
          clearTimeout(other.timer);
          this.pending.delete(otherId);
          other.resolve(true);
        }
      }
      entry.resolve(true);
      return true;
    }

    entry.resolve(resolution === 'allow_once');
    return true;
  }

  cancelByCallId(callId: string): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.item.callId === callId) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve(false);
      }
    }
  }

  snapshot(): PermissionSnapshot {
    return {
      policy: this.getPolicy(),
      sessionGrants: [...this.sessionGrants],
      pending: [...this.pending.values()].map((w) => w.item),
    };
  }
}
