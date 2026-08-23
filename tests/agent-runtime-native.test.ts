import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '@/lib/agent/runtime';
import { ToolRegistry } from '@/lib/agent/tools/registry';
import type { ExecutorReply, NativeBridge } from '@/lib/agent/tools/types';
import { nativeEchoTool } from '@/lib/agent/tools/native-echo';
import { demoEchoTool } from '@/lib/agent/tools/demo-echo';

function registryWithNative(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(demoEchoTool);
  r.register(nativeEchoTool);
  return r;
}

function ok(result: unknown): ExecutorReply {
  return { status: 'ok', result, durationMs: 1 };
}

describe('runtime → native capability layer', () => {
  it('routes execution:"native" tools through the bridge', async () => {
    const calls: string[] = [];
    const bridge: NativeBridge = {
      async execute(name) {
        calls.push(name);
        return ok({ text: 'via-host', host: 'gptpp-native' });
      },
    };
    const exec = createToolExecutor({ registry: registryWithNative(), nativeBridge: bridge });
    const reply = await exec({
      call: { id: 'c1', name: 'native_echo', arguments: { text: 'x' } },
    });
    expect(calls).toEqual(['native_echo']);
    expect(reply).toMatchObject({ status: 'ok', result: { text: 'via-host' } });
  });

  it('returns NATIVE_HOST_UNAVAILABLE when the bridge reports it', async () => {
    const bridge: NativeBridge = {
      async execute() {
        return {
          status: 'error',
          error: { code: 'NATIVE_HOST_UNAVAILABLE', message: 'GPT++ Native Host is unavailable.' },
        };
      },
    };
    const exec = createToolExecutor({ registry: registryWithNative(), nativeBridge: bridge });
    const reply = await exec({
      call: { id: 'c2', name: 'native_echo', arguments: { text: 'x' } },
    });
    expect(reply.status === 'error' && reply.error.code).toBe('NATIVE_HOST_UNAVAILABLE');
  });

  it('passes through host-side structured errors (unknown method etc.)', async () => {
    const bridge: NativeBridge = {
      async execute() {
        return {
          status: 'error',
          error: { code: 'TOOL_ERROR', message: 'native: INVALID_ARGUMENTS: bad args' },
        };
      },
    };
    const exec = createToolExecutor({ registry: registryWithNative(), nativeBridge: bridge });
    const reply = await exec({
      call: { id: 'c3', name: 'native_echo', arguments: { text: 'x' } },
    });
    expect(reply.status === 'error' && reply.error.message).toContain('INVALID_ARGUMENTS');
  });

  it('still validates arguments against the schema before touching the bridge', async () => {
    let bridgeCalls = 0;
    const bridge: NativeBridge = {
      async execute() {
        bridgeCalls += 1;
        return ok({});
      },
    };
    const exec = createToolExecutor({ registry: registryWithNative(), nativeBridge: bridge });
    const reply = await exec({
      call: { id: 'c4', name: 'native_echo', arguments: { text: 'x', wrong: true } },
    });
    expect(bridgeCalls).toBe(0); // schema gate first
    expect(reply.status === 'error' && reply.error.code).toBe('UNKNOWN_ARGUMENT');
  });

  it('keeps local tools untouched by the bridge', async () => {
    let bridgeCalls = 0;
    const bridge: NativeBridge = {
      async execute() {
        bridgeCalls += 1;
        return ok({});
      },
    };
    const exec = createToolExecutor({ registry: registryWithNative(), nativeBridge: bridge });
    const reply = await exec({
      call: { id: 'c5', name: 'demo_echo', arguments: { text: 'local' } },
    });
    expect(bridgeCalls).toBe(0);
    expect(reply).toMatchObject({ status: 'ok', result: { text: 'local' } });
  });

  it('reports a missing bridge as NATIVE_HOST_UNAVAILABLE', async () => {
    const exec = createToolExecutor({ registry: registryWithNative() });
    const reply = await exec({
      call: { id: 'c6', name: 'native_echo', arguments: { text: 'x' } },
    });
    expect(reply.status === 'error' && reply.error.code).toBe('NATIVE_HOST_UNAVAILABLE');
  });

  it('applies the permission handshake to risky native tools before bridging', async () => {
    const seen: Array<string | undefined> = [];
    let bridgeCalls = 0;
    const bridge: NativeBridge = {
      async execute() {
        bridgeCalls += 1;
        return ok({});
      },
    };
    const riskyNative = {
      ...nativeEchoTool,
      name: 'risky_native',
      risk: 'read' as const,
    };
    const r = registryWithNative();
    r.register(riskyNative);

    const exec = createToolExecutor({
      registry: r,
      nativeBridge: bridge,
      policy: ({ name }) => {
        seen.push(name);
        return name === 'risky_native' ? 'ask' : 'allow';
      },
      resolveAsk: async ({ toolName }) => toolName === 'risky_native',
    });

    // Round 1: permission_required
    const first = await exec({ call: { id: 'c7', name: 'risky_native', arguments: { text: 'x' } } });
    expect(first).toMatchObject({ status: 'permission_required', toolName: 'risky_native' });
    expect(bridgeCalls).toBe(0);

    // Round 2 with confirmation → executes in the host
    const second = await exec({
      call: { id: 'c8', name: 'risky_native', arguments: { text: 'x' } },
      confirmPermission: true,
    });
    expect(second.status).toBe('ok');
    expect(bridgeCalls).toBe(1);
  });
});
