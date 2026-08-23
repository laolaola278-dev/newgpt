// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter } from '@/lib/chatgpt/adapter';
import { AgentLoopController } from '@/lib/agent/loop/controller';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultPermissionPolicy } from '@/lib/agent/permission';
import { ToolRegistry } from '@/lib/agent/tools/registry';
import type { ExecutorReply } from '@/lib/agent/tools/types';
import type { ToolExecutePayload } from '@/lib/agent/tools/types';
import { demoEchoTool } from '@/lib/agent/tools/demo-echo';
import {
  appendMessage,
  mountPage,
  pulseObserver,
  setGenerating,
} from './fixtures';

function envelope(id: string, body: string): string {
  return `<gptpp:tool_call id="${id}">\n${body}\n</gptpp:tool_call>`;
}

interface Harness {
  adapter: ChatGPTAdapter;
  controller: AgentLoopController;
  events: Array<{ name: string; payload: unknown }>;
  sendClicks: () => number;
  registry: ToolRegistry;
}

// Dispose even when a test fails, so observers never leak across cases.
const activeHarnesses: Harness[] = [];
afterEach(() => {
  for (const h of activeHarnesses) {
    h.controller.dispose();
    h.adapter.dispose();
  }
  activeHarnesses.length = 0;
  document.body.innerHTML = '';
});

function setup(opts?: {
  maxSteps?: number;
  executeTool?: (payload: ToolExecutePayload) => Promise<ExecutorReply>;
}): Harness {
  mountPage();
  const adapter = new ChatGPTAdapter({ doc: document, streamStabilityMs: 80 });

  const registry = new ToolRegistry();
  registry.register(demoEchoTool);
  const executor =
    opts?.executeTool ??
    createToolExecutor({
      registry,
      policy: defaultPermissionPolicy,
      toolTimeoutMs: 500,
    });

  const events: Array<{ name: string; payload: unknown }> = [];
  const controller = new AgentLoopController({
    adapter,
    executeTool: executor,
    limits: { maxAgentSteps: opts?.maxSteps ?? 20, requestTimeoutMs: 4000 },
  });
  for (const name of [
    'state-changed',
    'tool-started',
    'tool-finished',
    'duplicate-blocked',
    'limit-reached',
    'turn-completed',
    'parse-issue',
  ] as const) {
    controller.on(name, (payload) => events.push({ name, payload }));
  }

  let clicks = 0;
  document.querySelector('[data-testid="send-button"]')?.addEventListener('click', () => {
    clicks += 1;
  });

  adapter.start();
  controller.start();

  const harness: Harness = {
    adapter,
    controller,
    events,
    sendClicks: () => clicks,
    registry,
  };
  activeHarnesses.push(harness);
  return harness;
}

async function assistantSays(text: string): Promise<void> {
  appendMessage({ role: 'assistant', id: `a-${Math.random().toString(36).slice(2, 8)}`, text });
  pulseObserver();
}

describe('Agent Loop integration', () => {
  it('runs the full cycle: tool call → execution → result injected → submit', async () => {
    const h = setup();

    await assistantSays(
      `Let me check. ${envelope('call_001', '{"name":"demo_echo","arguments":{"text":"hello"}}')}`,
    );

    await vi.waitFor(() => {
      expect(h.sendClicks()).toBeGreaterThanOrEqual(1);
    });
    const composer = document.getElementById('prompt-textarea')!;
    expect(composer.textContent).toContain('[GPT++ TOOL RESULT]');
    expect(composer.textContent).toContain('tool: demo_echo');
    expect(composer.textContent).toContain('call_id: call_001');
    expect(composer.textContent).toContain('"text": "hello"');

    await vi.waitFor(() => {
      expect(h.controller.snapshot().state).toBe('COMPLETED');
    });
    expect(h.controller.snapshot().steps).toBe(1);
    const finished = h.events.find((e) => e.name === 'tool-finished') as {
      payload: { ok: boolean; resultPreview: string };
    };
    expect(finished.payload.ok).toBe(true);
    expect(finished.payload.resultPreview).toContain('hello');

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('reports UNKNOWN_TOOL back into the conversation for unknown tools', async () => {
    const h = setup();

    await assistantSays(envelope('call_u1', '{"name":"demo_nope","arguments":{}}'));

    await vi.waitFor(() => {
      expect(h.sendClicks()).toBeGreaterThanOrEqual(1);
    });
    const composer = document.getElementById('prompt-textarea')!;
    expect(composer.textContent).toContain('error:');
    expect(composer.textContent).toContain('UNKNOWN_TOOL');
    expect(h.controller.snapshot().state).toBe('COMPLETED');

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('blocks duplicate call ids instead of re-executing them', async () => {
    const h = setup();
    const dup = envelope('call_dup', '{"name":"demo_echo","arguments":{"text":"once"}}');

    await assistantSays(dup);
    await vi.waitFor(() => {
      expect(h.sendClicks()).toBe(1);
    });

    // The model repeats itself — must not run again.
    await assistantSays(dup);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.sendClicks()).toBe(1);
    expect(h.events.some((e) => e.name === 'duplicate-blocked')).toBe(true);

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('holds calls while streaming and drains them after stream-end', async () => {
    const h = setup();

    setGenerating(true);
    const el = appendMessage({ role: 'assistant', id: 'stream-a', text: '' });
    pulseObserver();

    // Simulate tokens arriving while generating.
    el.querySelector('.whitespace-pre-wrap')!.textContent =
      'calling <gptpp:tool_call id="call_s1">{"name":"demo_ech';
    pulseObserver();
    el.querySelector('.whitespace-pre-wrap')!.textContent =
      `calling ${envelope('call_s1', '{"name":"demo_echo","arguments":{"text":"streamed"}}')}`;
    pulseObserver();

    await new Promise((r) => setTimeout(r, 60));
    expect(h.sendClicks()).toBe(0); // still streaming — nothing executed yet

    setGenerating(false); // generation finished
    pulseObserver();
    await vi.waitFor(() => {
      expect(h.sendClicks()).toBe(1);
    });
    const composer = document.getElementById('prompt-textarea')!;
    expect(composer.textContent).toContain('streamed');

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('stops at maxAgentSteps and reports the dropped remainder', async () => {
    const h = setup({ maxSteps: 1 });

    await assistantSays(
      [
        envelope('c_a', '{"name":"demo_echo","arguments":{"text":"a"}}'),
        envelope('c_b', '{"name":"demo_echo","arguments":{"text":"b"}}'),
      ].join('\n'),
    );

    await vi.waitFor(() => {
      expect(h.sendClicks()).toBe(1);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sendClicks()).toBe(1); // second call never ran
    const limited = h.events.find((e) => e.name === 'limit-reached') as
      | { payload: { steps: number; dropped: number } }
      | undefined;
    expect(limited?.payload.dropped).toBe(1);

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('supports multi-step loops across successive assistant messages', async () => {
    const h = setup();

    await assistantSays(envelope('step_1', '{"name":"demo_echo","arguments":{"text":"first"}}'));
    await vi.waitFor(() => {
      expect(h.sendClicks()).toBe(1);
    });

    // ChatGPT "continues" with another tool call.
    await assistantSays(envelope('step_2', '{"name":"demo_echo","arguments":{"text":"second"}}'));
    await vi.waitFor(() => {
      expect(h.sendClicks()).toBe(2);
    });
    const composer = document.getElementById('prompt-textarea')!;
    expect(composer.textContent).toContain('step_2');

    h.controller.dispose();
    h.adapter.dispose();
  });

  it('cancel() stops the loop and pending results are discarded', async () => {
    let resolveExec!: (reply: ExecutorReply) => void;
    const h = setup({
      executeTool: () =>
        new Promise<ExecutorReply>((resolve) => {
          resolveExec = resolve;
        }),
    });

    await assistantSays(envelope('call_cancel', '{"name":"demo_echo","arguments":{"text":"x"}}'));
    await vi.waitFor(() => {
      expect(['TOOL_DETECTED', 'WAITING_PERMISSION', 'EXECUTING']).toContain(
        h.controller.snapshot().state,
      );
    });

    h.controller.cancel();
    resolveExec({ status: 'ok', result: { text: 'late' }, durationMs: 0 });
    await new Promise((r) => setTimeout(r, 80));

    expect(h.controller.snapshot().state).toBe('CANCELLED');
    expect(h.sendClicks()).toBe(0);
    expect(document.getElementById('prompt-textarea')!.textContent ?? '').not.toContain(
      '[GPT++ TOOL RESULT]',
    );

    h.controller.dispose();
    h.adapter.dispose();
  });
});
