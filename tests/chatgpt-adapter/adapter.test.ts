// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter } from '@/lib/chatgpt/adapter';
import type { ChatGPTAdapterEvents } from '@/lib/chatgpt/types';
import {
  appendMessage,
  mountPage,
  pulseObserver,
  setGenerating,
  setMessageText,
} from './fixtures';

const CONV_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONV_B = '11111111-2222-4333-8444-555555555555';

interface RecordedEvent {
  name: keyof ChatGPTAdapterEvents;
  payload: unknown;
}

function setup(stabilityMs = 200) {
  const adapter = new ChatGPTAdapter({ doc: document, streamStabilityMs: stabilityMs });
  const events: RecordedEvent[] = [];
  const record = <K extends keyof ChatGPTAdapterEvents>(k: K) =>
    adapter.on(k, (payload) => events.push({ name: k, payload }));
  const keys: (keyof ChatGPTAdapterEvents)[] = [
    'ready',
    'navigation',
    'message-added',
    'message-updated',
    'stream-start',
    'stream-update',
    'stream-end',
    'composer-changed',
  ];
  for (const k of keys) record(k);
  return { adapter, events };
}

async function flush(): Promise<void> {
  await vi.waitFor(() => {}, { timeout: 50 });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // Nothing global persists between cases; adapters are per-test.
});

describe('ChatGPT page detection', () => {
  it('Test 1: detects a ChatGPT-like page and reports unavailability on empty DOM', async () => {
    const { adapter, events } = setup();
    expect(adapter.isAvailable()).toBe(false);
    adapter.start();
    expect(events.some((e) => e.name === 'ready')).toBe(false);

    mountPage();
    pulseObserver();
    await vi.waitFor(() => {
      expect(events.some((e) => e.name === 'ready')).toBe(true);
    });
    expect(adapter.isAvailable()).toBe(true);
  });

  it('Test 2: extracts the conversation id from /c/<uuid> paths', () => {
    const { adapter } = setup();
    window.history.replaceState(null, '', `/c/${CONV_A}`);
    expect(adapter.getConversationId()).toBe(CONV_A);
    window.history.replaceState(null, '', '/');
    expect(adapter.getConversationId()).toBeNull();
  });

  it('Test 10: emits navigation when the SPA switches conversations without reload', async () => {
    const { adapter, events } = setup();
    window.history.replaceState(null, '', `/c/${CONV_A}`);
    mountPage({ messages: [{ role: 'user', id: 'u1', text: 'hi' }] });
    adapter.start();

    // Open a stream on conversation A.
    setGenerating(true);
    appendMessage({ role: 'assistant', id: 'a1', text: 'working…' });
    pulseObserver();
    await vi.waitFor(() => {
      expect(adapter.isStreaming()).toBe(true);
    });

    // SPA-switch to conversation B: fresh view, no generation controls.
    window.history.replaceState(null, '', `/c/${CONV_B}`);
    mountPage();
    pulseObserver();

    await vi.waitFor(() => {
      const nav = events.find((e) => e.name === 'navigation');
      expect(nav).toBeDefined();
      expect((nav!.payload as { conversationId: string }).conversationId).toBe(CONV_B);
    });
    // An open stream must be closed by the navigation reset.
    await vi.waitFor(() => {
      expect(events.some((e) => e.name === 'stream-end')).toBe(true);
    });
    expect(adapter.isStreaming()).toBe(false);
  });
});

describe('Composer control', () => {
  it('Test 3: finds the composer through primary and fallback selectors', () => {
    const { adapter } = setup();
    mountPage();
    expect(adapter.getComposer()?.id).toBe('prompt-textarea');

    // Fallback 1: unnamed contenteditable inside a form.
    document.body.innerHTML = '<form><div contenteditable="true" role="textbox"></div></form>';
    expect(adapter.getComposer()?.tagName).toBe('DIV');

    // Fallback 2: plain textarea.
    document.body.innerHTML = '<form><textarea aria-label="Prompt"></textarea></form>';
    expect(adapter.getComposer()?.tagName).toBe('TEXTAREA');
  });

  it('Test 4: reads composer text', () => {
    const { adapter } = setup();
    mountPage();
    document.querySelector('#prompt-textarea')!.textContent = 'hello agent';
    expect(adapter.getComposerText()).toBe('hello agent');
    expect(adapter.getComposerText()).toBe('hello agent');
  });

  it('Test 5: writes composer text and fires input events React can observe', () => {
    const { adapter } = setup();
    mountPage();
    const composer = document.getElementById('prompt-textarea')!;
    const seen: string[] = [];
    composer.addEventListener('input', () => seen.push(composer.textContent ?? ''));

    expect(adapter.setComposerText('write me a test')).toBe(true);
    expect(adapter.getComposerText()).toBe('write me a test');
    expect(seen).toContain('write me a test');
  });
});

describe('Message detection', () => {
  it('Test 6: recognizes user messages as they appear', async () => {
    const { adapter, events } = setup();
    mountPage();
    adapter.start();

    appendMessage({ role: 'user', id: 'm-user', text: '帮我检查当前项目的结构' });
    pulseObserver();

    await vi.waitFor(() => {
      expect(events.filter((e) => e.name === 'message-added')).toHaveLength(1);
    });
    expect(adapter.getMessages()[0]?.role).toBe('user');
    expect(adapter.getMessages()[0]?.content).toBe('帮我检查当前项目的结构');
    expect(adapter.getLastAssistantMessage()).toBeNull();
  });

  it('Test 7: recognizes assistant messages and exposes the last one', async () => {
    const { adapter, events } = setup();
    mountPage({
      messages: [
        { role: 'user', id: 'u1', text: 'run tests' },
        { role: 'assistant', id: 'a1', text: 'All green.' },
        { role: 'assistant', id: 'a2', text: 'Now fixing the flaky one.' },
      ],
    });
    adapter.start();
    await flush();

    const assistant = events.filter(
      (e) =>
        e.name === 'message-added' &&
        (e.payload as { message: { role: string } }).message.role === 'assistant',
    );
    expect(assistant).toHaveLength(2);
    expect(adapter.getLastAssistantMessage()?.id).toBe('a2');
    expect(adapter.getMessages().length).toBe(3);
  });

  it('derives stable ids for messages lacking data-message-id', async () => {
    const { adapter } = setup();
    mountPage();
    adapter.start();
    const el = appendMessage({ role: 'assistant', id: 'ignored-by-fixture', text: 'x' });
    el.removeAttribute('data-message-id');
    pulseObserver();

    await flush();
    const msgs = adapter.getMessages();
    expect(msgs[0]?.id).toMatch(/^assistant-/);
    expect(adapter.getMessages()[0]?.id).toBe(msgs[0]!.id);
  });

  it('marks only the latest assistant message as streaming and resolves split wrapper attributes', async () => {
    const { adapter } = setup(120);
    mountPage({
      messages: [
        { role: 'user', id: 'u1', text: 'first' },
        { role: 'assistant', id: 'a1', text: 'first answer' },
        { role: 'user', id: 'u2', text: 'second' },
      ],
    });
    // Add nested outer role + inner data-message-id structure.
    document.getElementById('thread')!.insertAdjacentHTML(
      'beforeend',
      '<div data-message-author-role="assistant"><div data-message-id="nested-a2">streaming answer</div></div>',
    );
    setGenerating(true);
    adapter.start();
    pulseObserver();

    await flush();
    const msgs = adapter.getMessages();
    expect(msgs).toHaveLength(4);
    expect(msgs[1]?.streaming).toBe(false);
    expect(msgs[3]?.role).toBe('assistant');
    expect(msgs[3]?.id).toBe('nested-a2');
    expect(msgs[3]?.streaming).toBe(true);
    adapter.dispose();
  });
});

describe('Streaming detection', () => {
  it('Test 8 + 9: tracks streaming updates and detects the end deterministically', async () => {
    const { adapter, events } = setup(120);
    mountPage();
    adapter.start();

    // Turn begins; generation indicator shows up with an empty reply bubble.
    setGenerating(true);
    const el = appendMessage({ role: 'assistant', id: 'stream-1', text: '' });
    pulseObserver();
    await flush();
    setMessageText('stream-1', 'A');
    pulseObserver();
    await vi.waitFor(() => {
      expect(events.some((e) => e.name === 'stream-start')).toBe(true);
    });
    expect(el).toBeInstanceOf(HTMLElement);

    setMessageText('stream-1', 'ABC');
    setMessageText('stream-1', 'ABCD');
    pulseObserver();
    await vi.waitFor(() => {
      expect(
        events.filter((e) => e.name === 'stream-update').length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(adapter.isStreaming()).toBe(true);
    expect(adapter.getLastAssistantMessage()?.content).toBe('ABCD');

    // Generation finishes: stop button disappears, quiet window elapses.
    setGenerating(false);
    await new Promise((r) => setTimeout(r, 220));
    await vi.waitFor(() => {
      expect(events.some((e) => e.name === 'stream-end')).toBe(true);
    });
    expect(adapter.isStreaming()).toBe(false);
    const ended = events.find((e) => e.name === 'stream-end')!;
    const endedMsg = ended.payload as { message: { streaming?: boolean; content: string } | null };
    expect(endedMsg.message?.streaming).toBe(false);
    expect(endedMsg.message?.content).toBe('ABCD');
  });

  it('keeps streaming while the stop button stays visible', async () => {
    const { adapter } = setup(80);
    mountPage();
    adapter.start();

    setGenerating(true);
    appendMessage({ role: 'assistant', id: 's', text: '' });
    pulseObserver();
    await vi.waitFor(() => {
      expect(adapter.isStreaming()).toBe(true);
    });

    await new Promise((r) => setTimeout(r, 300)); // far beyond the quiet window
    expect(adapter.isStreaming()).toBe(true);
  });

  it('emits composer-changed when the composer is typed into', async () => {
    const { adapter, events } = setup();
    mountPage();
    adapter.start();

    document.querySelector('#prompt-textarea')!.textContent = 'typing…';
    pulseObserver();
    await vi.waitFor(() => {
      expect(events.some((e) => e.name === 'composer-changed')).toBe(true);
    });
  });
});
