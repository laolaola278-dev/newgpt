/**
 * Minimal permission core.
 *
 * A policy maps a tool to a decision; "ask" defers to an async resolver
 * (Side Panel UI in later phases, auto-deny by default today).
 * No permission center, no rule engine — one function per concern.
 */

import type { ToolDefinition, ToolRisk } from './tools/types';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export type PermissionPolicy = (tool: Pick<ToolDefinition, 'name' | 'risk'>) => PermissionDecision;

/** safe/low → allow, everything else → ask. */
export const defaultPermissionPolicy: PermissionPolicy = ({ risk }) =>
  risk === 'safe' || risk === 'low' ? 'allow' : 'ask';

export interface AskResolverContext {
  toolName: string;
  risk: ToolRisk;
  callId: string;
}

export type AskResolver = (ctx: AskResolverContext) => Promise<boolean>;

/**
 * Default consent resolver: deny with a console note. Replaced by real UI
 * wiring in the permission phase — the loop already treats it correctly.
 */
export const defaultAskResolver: AskResolver = async (ctx) => {
  console.warn(
    `[GPT++] permission ask for "${ctx.toolName}" (${ctx.risk}) denied automatically: no resolver installed`,
  );
  return false;
};
