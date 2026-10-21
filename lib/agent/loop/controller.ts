/**
 * AgentLoopController — page-side orchestration of the agent loop.
 *
 *   adapter events → parser → dedup/limits → runtime executor (background)
 *   → permission handshake → result formatting → adapter.injectMessage()
 *
 * It owns the state machine, the streaming parser and all loop guards. It
 * never executes tools itself (that is the runtime/background's job) and
 * never touches ChatGPT DOM beyond what the adapter exposes.
 */

import type { ChatGPTAdapter } from '@/lib/chatgpt/adapter';
import { StreamingToolCallParser } from '../tool-call/parser';
import type { ToolCall } from '../tool-call/types';
import { extractCompletedCallIds, formatToolResultBlock } from '../format';
import { AgentStateMachine, type AgentState } from '../state';
import type { ExecutorReply, ToolExecutePayload, ToolOutcome } from '../tools/types';
import {
  defaultAskResolver,
  type AskResolver,
  type PermissionPolicy,
} from '../permission';
import { Emitter } from '../emitter';

export interface AgentLoopLimits {
  /** Executed tool calls per turn (default 20). */
  maxAgentSteps?: number;
  /** Whole-request timeout per tool call, including round-trips (ms). */
  requestTimeoutMs?: number;
}

export interface AgentLoopDeps {
  adapter: ChatGPTAdapter;
  /** Transport to the runtime executor (RPC to background in production). */
  executeTool: (payload: ToolExecutePayload) => Promise<ExecutorReply>;
  policy?: PermissionPolicy;
  resolveAsk?: AskResolver;
  limits?: AgentLoopLimits;
}

export interface AgentLoopEvents {
  'state-changed': { state: AgentState };
  'tool-started': { call: ToolCall };
  'tool-finished': {
    callId: string;
    toolName: string;
    ok: boolean;
    durationMs: number | null;
    errorCode?: string;
    resultPreview?: string;
  };
  'duplicate-blocked': { callId: string; toolName: string };
  'limit-reached': { steps: number; dropped: number };
  'turn-completed': { steps: number };
  'parse-issue': { code: string; message: string };
}

export interface AgentStatusSnapshot {
  state: AgentState;
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

const MAX_TRACKED_CALL_IDS = 500;

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '' : text.slice(0, 160);
}

export class AgentLoopController {
  private emitter = new Emitter<AgentLoopEvents>();
  private sm = new AgentStateMachine();
  private parser = new StreamingToolCallParser();

  private activeAssistantEl: HTMLElement | null = null;
  private queue: ToolCall[] = [];
  private executedCallIds = new Map<string, number>();
  private steps = 0;
  private draining = false;
  private injecting = false;
  private lastInjectionAt = 0;
  private cancelled = false;
  private started = false;

  private lastTool: AgentStatusSnapshot['lastTool'] = null;
  private offs: Array<() => void> = [];

  private readonly maxSteps: number;
  private readonly requestTimeoutMs: number;
  private readonly resolveAsk: AskResolver;

  constructor(private deps: AgentLoopDeps) {
    this.maxSteps = deps.limits?.maxAgentSteps ?? 20;
    this.requestTimeoutMs = deps.limits?.requestTimeoutMs ?? 15_000;
    this.resolveAsk = deps.resolveAsk ?? defaultAskResolver;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.cancelled = false;
    this.syncHistoricalCallIds();

    if (!this.started) {
      this.started = true;
      const { adapter } = this.deps;

      const onAdded = (p: { message: { role: string; content: string; element?: HTMLElement } }) =>
        this.onAssistantAdded(p.message.role, p.message.content, p.message.element);
      const onUpdated = (p: { message: { role: string; content: string; element?: HTMLElement } }) =>
        this.onAssistantUpdated(p.message.role, p.message.content, p.message.element);
      const onStreamEnd = () => void this.drain();
      const onNav = () => this.onNavigation();

      this.offs.push(
        adapter.on('message-added', onAdded),
        adapter.on('message-updated', onUpdated),
        adapter.on('stream-end', onStreamEnd),
        adapter.on('navigation', onNav),
      );
    }

    if (
      this.sm.state === 'IDLE' ||
      this.sm.state === 'COMPLETED' ||
      this.sm.state === 'CANCELLED' ||
      this.sm.state === 'FAILED'
    ) {
      this.transition('OBSERVING');
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    if (this.sm.state !== 'CANCELLED') {
      this.transition('CANCELLED');
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.started = false;
    this.queue = [];
    this.emitter.clear();
  }

  // ── events ───────────────────────────────────────────────────────────────

  on<K extends keyof AgentLoopEvents>(event: K, handler: (payload: AgentLoopEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  snapshot(): AgentStatusSnapshot {
    return {
      state: this.sm.state,
      steps: this.steps,
      queuedCalls: this.queue.length,
      lastTool: this.lastTool,
    };
  }

  // ── observation ──────────────────────────────────────────────────────────

  private syncHistoricalCallIds(): void {
    for (const msg of this.deps.adapter.getMessages()) {
      if (msg.role === 'user') {
        for (const id of extractCompletedCallIds(msg.content)) {
          this.rememberCallId(id);
        }
      }
    }
  }

  private onUserMessage(content: string): void {
    for (const id of extractCompletedCallIds(content)) {
      this.rememberCallId(id);
    }
    if (this.injecting) return; // our own injected result — not a new turn
    // Real ChatGPT renders the injected message asynchronously; ignore any
    // user message arriving shortly after our own injection.
    if (Date.now() - this.lastInjectionAt < 1500) return;
    this.cancelled = false;
    this.steps = 0;
    this.parser.reset();
    this.activeAssistantEl = null;
    if (
      this.sm.state === 'COMPLETED' ||
      this.sm.state === 'IDLE' ||
      this.sm.state === 'CANCELLED' ||
      this.sm.state === 'FAILED'
    ) {
      this.transition('OBSERVING');
    }
  }

  private onAssistantAdded(
    role: string,
    content: string,
    element?: HTMLElement,
  ): void {
    if (!this.started) return;
    if (role === 'user') {
      this.onUserMessage(content);
      return;
    }
    if (this.cancelled || role !== 'assistant') return;

    this.syncHistoricalCallIds();

    // Historical assistant messages followed by newer messages in the thread
    // (e.g. during SPA navigation / hydration) must never re-execute.
    if (element) {
      const messages = this.deps.adapter.getMessages();
      const tail = messages[messages.length - 1];
      if (tail?.element && tail.element !== element) return;
    }

    // A brand-new assistant message always starts a fresh parse buffer.
    this.parser.reset();
    this.activeAssistantEl = element ?? null;
    this.feedAssistant(content);
  }

  private onAssistantUpdated(
    role: string,
    content: string,
    element?: HTMLElement,
  ): void {
    if (this.cancelled || !this.started) return;
    if (role !== 'assistant') return;
    // Only the tracked assistant message feeds the parser; re-renders of
    // older history must not pollute the streaming buffer.
    if (element && this.activeAssistantEl && element !== this.activeAssistantEl) return;
    this.feedAssistant(content);
  }

  private feedAssistant(content: string): void {
    // New assistant activity re-engages the loop from any settled state.
    const st = this.sm.state;
    if (st === 'IDLE' || st === 'COMPLETED' || st === 'FAILED' || st === 'CANCELLED') {
      this.transition('OBSERVING');
    }
    const { calls, issues } = this.parser.feed(content);
    for (const issue of issues) {
      this.emitter.emit('parse-issue', { code: issue.code, message: issue.message });
    }

    let enqueuedNew = false;
    for (const call of calls) {
      if (this.executedCallIds.has(call.id)) {
        this.emitter.emit('duplicate-blocked', { callId: call.id, toolName: call.name });
        continue;
      }
      if (!call.name) continue; // validator would reject; skip early
      this.rememberCallId(call.id);
      this.queue.push(call);
      enqueuedNew = true;
    }

    // Execute immediately when the assistant is not mid-stream; otherwise
    // the stream-end handler drains the queue.
    if (enqueuedNew && !this.deps.adapter.isStreaming()) {
      void this.drain();
    }
  }

  private onNavigation(): void {
    this.cancelled = false;
    this.parser.reset();
    this.queue = [];
    this.steps = 0;
    this.activeAssistantEl = null;
    if (this.sm.state !== 'OBSERVING') {
      this.transition('OBSERVING');
    }
  }

  private rememberCallId(id: string): void {
    if (this.executedCallIds.size >= MAX_TRACKED_CALL_IDS) {
      const oldest = this.executedCallIds.keys().next().value;
      if (oldest !== undefined) this.executedCallIds.delete(oldest);
    }
    this.executedCallIds.set(id, (this.executedCallIds.get(id) ?? 0) + 1);
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.draining || this.cancelled) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        if (this.steps >= this.maxSteps) {
          this.emitter.emit('limit-reached', { steps: this.steps, dropped: this.queue.length });
          this.queue = [];
          break;
        }
        const call = this.queue.shift();
        if (!call) break;
        this.steps += 1;
        await this.handleCall(call);
        if (this.cancelled) break;
      }
      this.finishTurn();
    } finally {
      this.draining = false;
    }
  }

  private finishTurn(): void {
    if (this.cancelled) return;
    if (this.sm.state === 'OBSERVING') {
      this.transition('COMPLETED');
      this.emitter.emit('turn-completed', { steps: this.steps });
    }
  }

  private async handleCall(call: ToolCall): Promise<void> {
    if (this.cancelled) return;
    this.transition('TOOL_DETECTED');
    this.emitter.emit('tool-started', { call });
    const startedAt = Date.now();

    let reply: ExecutorReply;
    try {
      reply = await this.callExecutor({ call });
    } catch (err) {
      reply = {
        status: 'error',
        error: {
          code: 'TOOL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (this.cancelled) return;

    // Permission handshake.
    if (reply.status === 'permission_required') {
      this.transition('WAITING_PERMISSION');
      let granted = false;
      try {
        granted = await this.resolveAsk({
          toolName: reply.toolName,
          risk: reply.risk,
          callId: call.id,
        });
      } catch {
        granted = false;
      }
      if (this.cancelled) return;
      if (!granted) {
        reply = {
          status: 'error',
          error: { code: 'PERMISSION_DENIED', message: `Tool "${call.name}" was denied by the user` },
        };
      } else {
        this.transition('EXECUTING');
        try {
          reply = await this.callExecutor({ call, confirmPermission: true });
        } catch (err) {
          reply = {
            status: 'error',
            error: {
              code: 'TOOL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        if (this.cancelled) return;
      }
    } else {
      this.transition('EXECUTING');
    }

    const durationMs = Date.now() - startedAt;
    const outcome: ToolOutcome =
      reply.status === 'ok'
        ? { status: 'ok', result: reply.result, durationMs: reply.durationMs ?? durationMs }
        : reply.status === 'error'
          ? { status: 'error', error: reply.error }
          : {
              status: 'error',
              error: {
                code: 'PERMISSION_DENIED',
                message: 'permission handshake ended unresolved',
              },
            };

    // Inject the result so ChatGPT can continue.
    this.transition('INJECTING_RESULT');
    this.injecting = true;
    this.lastInjectionAt = Date.now();
    let injected = false;
    try {
      injected = await this.deps.adapter.injectMessage(
        formatToolResultBlock({ call, outcome }),
      );
    } finally {
      this.injecting = false;
      this.lastInjectionAt = Date.now();
    }
    if (this.cancelled) return;

    this.lastTool = {
      callId: call.id,
      toolName: call.name,
      ok: outcome.status === 'ok' && injected,
      durationMs: outcome.status === 'ok' ? outcome.durationMs : null,
      errorCode: outcome.status === 'error' ? outcome.error.code : injected ? undefined : 'INJECTION_FAILED',
      resultPreview: outcome.status === 'ok' ? preview(outcome.result) : undefined,
    };

    this.emitter.emit('tool-finished', {
      callId: call.id,
      toolName: call.name,
      ok: this.lastTool.ok,
      durationMs: this.lastTool.durationMs,
      errorCode: this.lastTool.errorCode,
      resultPreview: this.lastTool.resultPreview,
    });

    if (!injected) {
      this.transition('FAILED');
      return;
    }
    this.transition('CONTINUING');
    this.transition('OBSERVING');
  }

  private async callExecutor(payload: ToolExecutePayload): Promise<ExecutorReply> {
    return new Promise<ExecutorReply>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ status: 'error', error: { code: 'TIMEOUT', message: `tool request exceeded ${this.requestTimeoutMs}ms` } }),
        this.requestTimeoutMs,
      );
      this.deps
        .executeTool(payload)
        .then(
          (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
    });
  }

  private transition(next: AgentState): void {
    const prev = this.sm.state;
    const state = this.sm.to(next);
    if (state !== prev) this.emitter.emit('state-changed', { state });
  }
}
