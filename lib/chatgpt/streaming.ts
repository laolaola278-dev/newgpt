/**
 * Streaming state machine.
 *
 * Primary end-of-generation signal is the DOM itself (stop button visibility,
 * assistant text mutations). A short "stability window" is only the fallback
 * used when the stop button cannot be observed — fixed delays are never the
 * primary mechanism.
 *
 *   idle ──activity/stop-btn──▶ streaming ──quiet window──▶ idle
 *
 * Transitions are synchronous and deterministic, which keeps the machine
 * unit-testable with fake timers.
 */

export type StreamState = 'idle' | 'streaming';

export interface StreamingDetectorOptions {
  /** Quiet period (ms) after the last activity before we declare the stream over. */
  stabilityMs?: number;
  onStart?: () => void;
  onUpdate?: () => void;
  onEnd?: () => void;
}

export class StreamingDetector {
  state: StreamState = 'idle';

  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stabilityMs: number;
  private readonly handlers: StreamingDetectorOptions;
  private hint = false;

  constructor(options: StreamingDetectorOptions = {}) {
    this.handlers = options;
    this.stabilityMs = options.stabilityMs ?? 900;
  }

  /** Generation hint from the stop button (the strong signal). */
  setGenerating(active: boolean): void {
    this.hint = active;
    if (active) {
      this.clearStabilityTimer();
      if (this.state === 'idle') this.begin();
      return;
    }
    // Stop button gone: if we were streaming, start the quiet-window countdown.
    if (this.state === 'streaming') this.armStabilityTimer();
  }

  /** Assistant-side DOM activity (text grew, nodes changed). */
  noteActivity(): void {
    if (this.state === 'idle') {
      this.begin();
    } else {
      this.handlers.onUpdate?.();
    }
    // Fresh activity pushes the quiet window out — but never while the stop
    // button says generation is still running.
    if (!this.hint) this.armStabilityTimer();
  }

  /** Hard reset (SPA navigation, dispose). Emits end if a stream was open. */
  reset(): void {
    this.clearStabilityTimer();
    if (this.state === 'streaming') {
      this.state = 'idle';
      this.handlers.onEnd?.();
    }
  }

  private begin(): void {
    this.state = 'streaming';
    this.handlers.onStart?.();
  }

  private armStabilityTimer(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.state === 'streaming') {
        this.state = 'idle';
        this.handlers.onEnd?.();
      }
    }, this.stabilityMs);
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }
}
