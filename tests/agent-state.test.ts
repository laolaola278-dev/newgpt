import { describe, expect, it } from 'vitest';
import {
  AgentStateMachine,
  IllegalTransitionError,
  canTransition,
  type AgentState,
} from '@/lib/agent/state';

describe('AgentStateMachine', () => {
  it('walks the legal happy path', () => {
    const sm = new AgentStateMachine();
    sm.to('OBSERVING');
    sm.to('TOOL_DETECTED');
    sm.to('EXECUTING');
    sm.to('INJECTING_RESULT');
    sm.to('CONTINUING');
    sm.to('OBSERVING');
    sm.to('COMPLETED');
    expect(sm.state).toBe('COMPLETED');
  });

  it('forbids IDLE → EXECUTING jumps', () => {
    const sm = new AgentStateMachine();
    expect(() => sm.to('EXECUTING')).toThrow(IllegalTransitionError);
    expect(sm.state).toBe('IDLE');
  });

  it('supports the permission path including denial injection', () => {
    const sm = new AgentStateMachine();
    sm.to('OBSERVING');
    sm.to('TOOL_DETECTED');
    sm.to('WAITING_PERMISSION');
    // denied → inject the error so ChatGPT can adapt
    sm.to('INJECTING_RESULT');
    sm.to('CONTINUING');
    expect(sm.state).toBe('CONTINUING');
  });

  it('can cancel from any active state', () => {
    const paths: Record<string, AgentState[]> = {
      OBSERVING: ['OBSERVING'],
      TOOL_DETECTED: ['OBSERVING', 'TOOL_DETECTED'],
      WAITING_PERMISSION: ['OBSERVING', 'TOOL_DETECTED', 'WAITING_PERMISSION'],
      EXECUTING: ['OBSERVING', 'TOOL_DETECTED', 'EXECUTING'],
    };
    for (const [mid, path] of Object.entries(paths)) {
      const sm = new AgentStateMachine();
      for (const step of path) sm.to(step as AgentState);
      expect(sm.state).toBe(mid);
      sm.to('CANCELLED');
      expect(sm.state).toBe('CANCELLED');
      expect(canTransition('CANCELLED', 'EXECUTING')).toBe(false);
    }
  });

  it('allows re-entry after completion and recovery after failure', () => {
    expect(canTransition('COMPLETED', 'OBSERVING')).toBe(true);
    expect(canTransition('FAILED', 'IDLE')).toBe(true);
    const sm = new AgentStateMachine();
    sm.to('OBSERVING');
    sm.to('FAILED');
    sm.to('OBSERVING');
    expect(sm.state).toBe('OBSERVING');
  });

  it('isActive reflects observation state', () => {
    const sm = new AgentStateMachine();
    expect(sm.isActive()).toBe(false);
    sm.to('OBSERVING');
    expect(sm.isActive()).toBe(true);
  });
});
