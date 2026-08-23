import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '@/lib/agent/runtime';
import { defaultPermissionPolicy } from '@/lib/agent/permission';
import { ToolRegistry } from '@/lib/agent/tools/registry';
import type { ToolDefinition } from '@/lib/agent/tools/types';
import { demoEchoTool } from '@/lib/agent/tools/demo-echo';

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(demoEchoTool);

  const riskyProbe: ToolDefinition = {
    name: 'risky_probe',
    description: 'test-only risky tool',
    inputSchema: { type: 'object', properties: {} },
    risk: 'read',
    async execute() {
      return { probed: true };
    },
  };
  const slowEcho: ToolDefinition = {
    name: 'slow_echo',
    description: 'test-only slow tool',
    inputSchema: demoEchoTool.inputSchema,
    risk: 'safe',
    async execute(args) {
      await new Promise((r) => setTimeout(r, 150));
      return args;
    },
  };
  const broken: ToolDefinition = {
    name: 'broken',
    description: 'always throws',
    inputSchema: { type: 'object', properties: {} },
    risk: 'safe',
    async execute() {
      throw new Error('boom');
    },
  };
  registry.register(riskyProbe);
  registry.register(slowEcho);
  registry.register(broken);
  return registry;
}

function makeExecutor(overrides?: { toolTimeoutMs?: number }) {
  return createToolExecutor({
    registry: makeRegistry(),
    policy: defaultPermissionPolicy,
    toolTimeoutMs: overrides?.toolTimeoutMs ?? 1000,
  });
}

const call = (name: string, args: Record<string, unknown> = {}, id = 'c1') => ({
  id,
  name,
  arguments: args,
});

describe('runtime executor pipeline', () => {
  it('rejects unknown tools with a structured error', async () => {
    const reply = await makeExecutor()( { call: call('demo_nope') });
    expect(reply).toEqual({
      status: 'error',
      error: {
        code: 'UNKNOWN_TOOL',
        message: 'Unknown GPT++ tool: demo_nope',
      },
    });
  });

  it('executes demo_echo end to end', async () => {
    const reply = await makeExecutor()({ call: call('demo_echo', { text: 'hello' }) });
    expect(reply).toEqual({ status: 'ok', result: { text: 'hello' }, durationMs: expect.any(Number) });
  });

  it('enforces the tool input schema (missing argument)', async () => {
    const reply = await makeExecutor()({ call: call('demo_echo', {}) });
    expect(reply.status === 'error' && reply.error.code).toBe('INVALID_ARGUMENTS');
  });

  it('enforces additionalProperties:false (unexpected argument)', async () => {
    const reply = await makeExecutor()({ call: call('demo_echo', { text: 'a', extra: 1 }) });
    expect(reply.status === 'error' && reply.error.code).toBe('UNKNOWN_ARGUMENT');
  });

  it('returns permission_required for risky tools under the default policy', async () => {
    const reply = await makeExecutor()({ call: call('risky_probe') });
    expect(reply).toEqual({ status: 'permission_required', risk: 'read', toolName: 'risky_probe' });
  });

  it('executes a risky tool after explicit confirmation', async () => {
    const exec = makeExecutor();
    const first = await exec({ call: call('risky_probe') });
    expect(first.status).toBe('permission_required');
    const second = await exec({ call: call('risky_probe'), confirmPermission: true });
    expect(second).toEqual({ status: 'ok', result: { probed: true }, durationMs: expect.any(Number) });
  });

  it('still honors deny even when confirm is set', async () => {
    const exec = createToolExecutor({
      registry: (() => {
        const r = new ToolRegistry();
        r.register(demoEchoTool);
        r.register({
          name: 'denied_tool',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          risk: 'safe',
          async execute() {
            return null;
          },
        });
        return r;
      })(),
      policy: ({ name }) => (name === 'denied_tool' ? 'deny' : 'allow'),
    });
    const reply = await exec({ call: call('denied_tool'), confirmPermission: true });
    expect(reply.status === 'error' && reply.error.code).toBe('PERMISSION_DENIED');
  });

  it('times out slow tools deterministically', async () => {
    const reply = await makeExecutor({ toolTimeoutMs: 30 })({ call: call('slow_echo', { text: 'x' }) });
    expect(reply.status === 'error' && reply.error.code).toBe('TIMEOUT');
  });

  it('wraps tool exceptions as TOOL_ERROR', async () => {
    const reply = await makeExecutor()({ call: call('broken') });
    expect(reply.status === 'error' && reply.error.code).toBe('TOOL_ERROR');
  });

  it('refuses duplicate registration in the registry', () => {
    const registry = new ToolRegistry();
    registry.register(demoEchoTool);
    expect(() => registry.register(demoEchoTool)).toThrow(/already registered/);
  });
});
