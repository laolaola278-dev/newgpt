/**
 * Tool system types — deliberately minimal.
 *
 * No ToolProvider / ToolManager / Orchestrator layers: a registry, plain
 * definitions, and one executor entry point. Native tools route through the
 * Native Bridge while sharing the exact same schema and permission gates.
 */

import type { InputSchema } from '../tool-call/validator';

export type PermissionScope = 'READ' | 'WRITE' | 'EXECUTE' | 'GIT' | 'BROWSER';

export type ToolRisk =
  | 'safe'
  | 'low'
  | 'read'
  | 'write'
  | 'execute'
  | 'git'
  | 'browser';

/** Where a tool actually runs. */
export type ToolExecution = 'local' | 'native';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
  risk: ToolRisk;
  /** Optional explicit 5-scope category override (derived from `risk` if omitted). */
  scope?: PermissionScope;
  /** Defaults to 'local'. Native tools are routed through the Native Bridge. */
  execution?: ToolExecution;
  /** Never called for execution:'native' tools (the bridge runs them). */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Capability layer between the tool router and the native host. */
export interface NativeBridge {
  execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExecutorReply>;
}

/** Structured outcome of executing a single tool call. */
export type ToolOutcome =
  | { status: 'ok'; result: unknown; durationMs: number }
  | { status: 'error'; error: ToolError };

export interface ToolError {
  code:
    | 'UNKNOWN_TOOL'
    | 'INVALID_ARGUMENTS'
    | 'UNKNOWN_ARGUMENT'
    | 'PERMISSION_DENIED'
    | 'TOOL_ERROR'
    | 'TIMEOUT'
    | 'NATIVE_HOST_UNAVAILABLE'
    | 'DUPLICATE_TOOL_CALL';
  message: string;
}

/**
 * Reply from the runtime executor for one tool_execute request.
 * `permission_required` pauses execution until the UI resolves consent and
 * the caller re-sends with confirmPermission.
 */
export type ExecutorReply =
  | ({ status: 'ok' } & Extract<ToolOutcome, { status: 'ok' }>)
  | { status: 'error'; error: ToolError }
  | {
      status: 'permission_required';
      risk: ToolRisk;
      scope?: PermissionScope;
      toolName: string;
    };

export interface ToolExecutePayload {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  /** Present on the second round-trip after the user grants consent. */
  confirmPermission?: boolean;
}
