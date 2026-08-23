/**
 * ChatGPTAdapter — the single primary interface between GPT++ internals and
 * the ChatGPT web page. No other module is allowed to query ChatGPT DOM
 * directly; everything goes through this class (or the probe layer it uses).
 *
 * Responsibilities:
 *  - availability / conversation / title detection
 *  - message listing (user & assistant) with stable ids
 *  - unified DOM observation → typed events (added/updated/stream/nav/composer)
 *  - streaming state machine wiring (stop-button signal + stability window)
 *  - composer read/write/submit that React-controlled editors actually see
 *
 * All page text is treated as untrusted data — never executed, never parsed
 * as instructions at this layer.
 */

import { Emitter } from './emitter';
import { extractText, listMessages, parseMessage } from './messages';
import {
  findComposer,
  findMessageElements,
  findSendButton,
  findStopButton,
} from './probe';
import {
  conversationIdFromPath,
  conversationTitleFromDoc,
} from './conversation';
import { StreamingDetector } from './streaming';
import type { ChatGPTAdapterEvents, ChatGPTMessage } from './types';

export interface ChatGPTAdapterOptions {
  /** Injectable document for tests. Defaults to the global document. */
  doc?: Document;
  /** Quiet-window length for end-of-stream detection (default 900ms). */
  streamStabilityMs?: number;
}

const COMPOSER_EVENT_THROTTLE_MS = 120;
const NAVIGATION_POLL_MS = 1000;

export class ChatGPTAdapter {
  private readonly doc: Document;
  private emitter = new Emitter<ChatGPTAdapterEvents>();
  private detector: StreamingDetector;

  private started = false;
  private disposed = false;
  private readyFired = false;

  private rootObserver: MutationObserver | null = null;
  private navTimer: ReturnType<typeof setInterval> | null = null;

  private composerEl: HTMLElement | null = null;
  private composerObserver: MutationObserver | null = null;
  private composerInputListener: (() => void) | null = null;
  private composerTimer: ReturnType<typeof setTimeout> | null = null;

  private currentPath: string | null = null;
  private lastTexts = new WeakMap<HTMLElement, string>();

  constructor(options: ChatGPTAdapterOptions = {}) {
    this.doc =
      options.doc ??
      (typeof document !== 'undefined'
        ? document
        : (() => {
            throw new Error('ChatGPTAdapter requires a document');
          })());
    this.detector = new StreamingDetector({
      stabilityMs: options.streamStabilityMs,
      onStart: () => this.emitStream('stream-start'),
      onUpdate: () => this.emitStream('stream-update'),
      onEnd: () => this.emitStream('stream-end'),
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Attach observers. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    this.rootObserver = new MutationObserver((muts) => this.handleMutations(muts));
    this.rootObserver.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Initial sweep (no navigation event for the very first path).
    this.checkNavigation();
    this.syncMessages();
    this.watchComposer();
    this.maybeFireReady();

    // Backup for SPA navigations that produce no observable mutation burst.
    this.navTimer = setInterval(() => this.checkNavigation(), NAVIGATION_POLL_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detector.reset();
    this.rootObserver?.disconnect();
    this.rootObserver = null;
    if (this.navTimer !== null) clearInterval(this.navTimer);
    this.navTimer = null;
    this.detachComposerWatcher();
    if (this.composerTimer !== null) clearTimeout(this.composerTimer);
    this.composerTimer = null;
    this.emitter.clear();
  }

  // ── events ───────────────────────────────────────────────────────────────

  on<K extends keyof ChatGPTAdapterEvents>(
    event: K,
    handler: (payload: ChatGPTAdapterEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  // ── public API ───────────────────────────────────────────────────────────

  isAvailable(): boolean {
    return (
      findComposer(this.doc) !== null ||
      findMessageElements(this.doc).length > 0 ||
      this.doc.querySelector('main') !== null
    );
  }

  getConversationId(): string | null {
    return conversationIdFromPath(this.location().pathname);
  }

  getConversationTitle(): string | null {
    return conversationTitleFromDoc(this.doc);
  }

  getMessages(): ChatGPTMessage[] {
    return listMessages(this.doc, this.isStreaming());
  }

  getLastAssistantMessage(): ChatGPTMessage | null {
    const msgs = this.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'assistant') return m;
    }
    return null;
  }

  isStreaming(): boolean {
    return this.detector.state === 'streaming';
  }

  getComposer(): HTMLElement | null {
    return findComposer(this.doc);
  }

  getComposerText(): string {
    const el = this.getComposer();
    if (!el) return '';
    if (el instanceof HTMLTextAreaElement) return el.value;
    return el.textContent ?? '';
  }

  /**
   * Replace the composer content in a way React-controlled editors notice.
   * Tries execCommand (fires native input pipeline), verifies the result,
   * then falls back to manual DOM rewrite + synthetic input events.
   */
  setComposerText(text: string): boolean {
    const el = this.getComposer();
    if (!el) return false;
    const win = this.doc.defaultView;
    try {
      el.focus();
      if (win && typeof win.getSelection?.() !== 'undefined') {
        const sel = win.getSelection();
        const range = this.doc.createRange();
        range.selectNodeContents(el);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      this.doc.execCommand('selectAll', false);
      this.doc.execCommand('insertText', false, text);
    } catch {
      /* fall through to manual strategy */
    }
    if (this.composerMatches(el, text)) return true;

    // Manual fallback (also the path exercised under jsdom).
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(this.doc.createTextNode(text));
    try {
      const EventCtor = win?.InputEvent ?? Event;
      el.dispatchEvent(new EventCtor('beforeinput', { bubbles: true, composed: true }));
      el.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
    } catch {
      /* event construction is best-effort */
    }
    return this.composerMatches(el, text);
  }

  /**
   * Submit the composer: click the send button when present/enabled, else
   * synthesize an Enter keydown on the composer. Returns whether an action
   * was dispatched.
   */
  submitComposer(): boolean {
    const button = findSendButton(this.doc);
    if (button && !(button as HTMLButtonElement).disabled) {
      button.click();
      return true;
    }
    const el = this.getComposer();
    if (!el) return false;
    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    // Legacy fields some handlers still read; not settable via the ctor.
    Object.defineProperty(keydown, 'keyCode', { value: 13 });
    Object.defineProperty(keydown, 'which', { value: 13 });
    el.dispatchEvent(keydown);
    return true;
  }

  /**
   * Inject an internal GPT++ message into the conversation (typed into the
   * composer and submitted). Used by the agent loop for tool results.
   * Returns whether the message was dispatched.
   */
  async injectMessage(text: string): Promise<boolean> {
    if (!this.setComposerText(text)) return false;
    // Give React-controlled editors a tick to reconcile before submitting.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return this.submitComposer();
  }

  // ── observation internals ────────────────────────────────────────────────

  private handleMutations(_mutations: MutationObserverMutation[]): void {
    if (this.disposed) return;
    this.checkNavigation();
    this.detector.setGenerating(findStopButton(this.doc) !== null);
    this.syncMessages();
    this.watchComposer();
    this.maybeFireReady();
  }

  private maybeFireReady(): void {
    if (this.readyFired || !this.isAvailable()) return;
    this.readyFired = true;
    this.emitter.emit('ready', undefined);
  }

  private checkNavigation(): void {
    const path = this.location().pathname;
    if (path === this.currentPath) return;
    const firstObservation = this.currentPath === null;
    this.currentPath = path;
    this.detector.reset(); // ends any open stream across conversation switches
    this.composerEl = null; // force composer watcher re-attach
    if (!firstObservation) {
      this.emitter.emit('navigation', { conversationId: this.getConversationId() });
    }
  }

  private syncMessages(): void {
    const elements = findMessageElements(this.doc);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!(el instanceof HTMLElement)) continue;
      const text = extractText(el);
      const prev = this.lastTexts.get(el);
      if (prev === text) continue;

      const streaming = this.isStreaming();
      const message = parseMessage(el, i, streaming);
      this.lastTexts.set(el, text);

      if (prev === undefined) {
        this.emitter.emit('message-added', { message });
      } else {
        this.emitter.emit('message-updated', { message });
      }
      // Assistant activity drives the streaming machine; its own callbacks
      // emit stream-start/update/end with freshly snapshotted messages.
      if (message.role === 'assistant') {
        this.detector.noteActivity();
      }
    }
  }

  private emitStream(event: 'stream-start' | 'stream-update' | 'stream-end'): void {
    this.emitter.emit(event, { message: this.getLastAssistantMessage() });
  }

  private watchComposer(): void {
    const el = this.getComposer();
    if (!el) return;
    if (this.composerObserver && el === this.composerEl) return;

    this.detachComposerWatcher();
    this.composerEl = el;

    const mo = new MutationObserver(() => this.queueComposerEvent());
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    this.composerObserver = mo;

    const onInput = () => this.queueComposerEvent();
    el.addEventListener('input', onInput, true);
    this.composerInputListener = () => el.removeEventListener('input', onInput, true);
  }

  private detachComposerWatcher(): void {
    this.composerObserver?.disconnect();
    this.composerObserver = null;
    this.composerInputListener?.();
    this.composerInputListener = null;
  }

  private queueComposerEvent(): void {
    if (this.composerTimer !== null) return;
    this.composerTimer = setTimeout(() => {
      this.composerTimer = null;
      this.emitter.emit('composer-changed', { text: this.getComposerText() });
    }, COMPOSER_EVENT_THROTTLE_MS);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private location(): Location {
    return (
      this.doc.defaultView?.location ??
      (typeof location !== 'undefined' ? location : new URL('https://chatgpt.com/') as unknown as Location)
    );
  }

  private composerMatches(el: HTMLElement, expected: string): boolean {
    const actual =
      el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '');
    return actual === expected;
  }
}

/** Local alias so the observer callback signature stays self-documenting. */
type MutationObserverMutation = MutationRecord;
