/**
 * Agent task state machine — explicit transition table, no implicit jumps.
 *
 *   IDLE → OBSERVING → TOOL_DETECTED → WAITING_PERMISSION? → EXECUTING
 *        → INJECTING_RESULT → CONTINUING → OBSERVING / COMPLETED
 *
 * FAILED is reserved for loop-level faults (e.g. injection failure);
 * tool-level errors still flow through INJECTING_RESULT so ChatGPT can see
 * them and adapt. CANCELLED is reachable from every active state.
 */

export type AgentState =
  | 'IDLE'
  | 'OBSERVING'
  | 'TOOL_DETECTED'
  | 'WAITING_PERMISSION'
  | 'EXECUTING'
  | 'INJECTING_RESULT'
  | 'CONTINUING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

const ACTIVE_STATES: readonly AgentState[] = [
  'IDLE',
  'OBSERVING',
  'TOOL_DETECTED',
  'WAITING_PERMISSION',
  'EXECUTING',
  'INJECTING_RESULT',
  'CONTINUING',
];

export const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  IDLE: ['OBSERVING', 'CANCELLED'],
  OBSERVING: ['TOOL_DETECTED', 'IDLE', 'COMPLETED', 'FAILED', 'CANCELLED'],
  TOOL_DETECTED: ['WAITING_PERMISSION', 'EXECUTING', 'FAILED', 'CANCELLED'],
  WAITING_PERMISSION: ['EXECUTING', 'INJECTING_RESULT', 'FAILED', 'CANCELLED'],
  EXECUTING: ['INJECTING_RESULT', 'FAILED', 'CANCELLED'],
  INJECTING_RESULT: ['CONTINUING', 'FAILED', 'CANCELLED'],
  CONTINUING: ['OBSERVING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['OBSERVING', 'IDLE', 'CANCELLED'],
  FAILED: ['IDLE', 'OBSERVING', 'CANCELLED'],
  CANCELLED: ['IDLE', 'OBSERVING'],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: AgentState,
    public readonly to: AgentState,
  ) {
    super(`illegal agent state transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class AgentStateMachine {
  private current: AgentState = 'IDLE';

  get state(): AgentState {
    return this.current;
  }

  can(to: AgentState): boolean {
    return canTransition(this.current, to);
  }

  /** Move if legal; throws IllegalTransitionError on illegal jumps. */
  to(next: AgentState): AgentState {
    if (!canTransition(this.current, next)) {
      throw new IllegalTransitionError(this.current, next);
    }
    this.current = next;
    return this.current;
  }

  isActive(): boolean {
    return ACTIVE_STATES.includes(this.current) && this.current !== 'IDLE';
  }
}
