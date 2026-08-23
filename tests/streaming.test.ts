import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingDetector } from '@/lib/chatgpt/streaming';

describe('StreamingDetector', () => {
  const STABILITY = 500;
  let d: StreamingDetector;
  let events: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    d = new StreamingDetector({
      stabilityMs: STABILITY,
      onStart: () => events.push('start'),
      onUpdate: () => events.push('update'),
      onEnd: () => events.push('end'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on first activity and emits updates afterwards', () => {
    d.noteActivity();
    expect(d.state).toBe('streaming');
    d.noteActivity();
    d.noteActivity();
    expect(events).toEqual(['start', 'update', 'update']);
  });

  it('starts when the stop button signal appears, without activity', () => {
    d.setGenerating(true);
    expect(d.state).toBe('streaming');
    expect(events).toEqual(['start']);
  });

  it('ends after the quiet window once generation hint clears', () => {
    d.setGenerating(true);
    d.setGenerating(false);
    vi.advanceTimersByTime(STABILITY - 1);
    expect(events).toEqual(['start']); // not yet
    vi.advanceTimersByTime(1);
    expect(d.state).toBe('idle');
    expect(events).toEqual(['start', 'end']);
  });

  it('does not end while the stop button remains visible', () => {
    d.noteActivity();
    d.setGenerating(true);
    // No stability timer should be armed while the hint is active.
    vi.advanceTimersByTime(STABILITY * 5);
    expect(d.state).toBe('streaming');
    expect(events).toEqual(['start']);
  });

  it('re-arms the quiet window on fresh activity', () => {
    d.noteActivity();
    d.setGenerating(false);
    vi.advanceTimersByTime(STABILITY - 100);
    d.noteActivity(); // pushes the window out
    vi.advanceTimersByTime(STABILITY - 100);
    expect(d.state).toBe('streaming');
    vi.advanceTimersByTime(100);
    expect(events).toEqual(['start', 'update', 'end']);
  });

  it('reset() closes an open stream immediately', () => {
    d.noteActivity();
    d.reset();
    expect(d.state).toBe('idle');
    expect(events).toEqual(['start', 'end']);
  });

  it('reset() is silent when idle', () => {
    d.reset();
    expect(events).toEqual([]);
  });
});
