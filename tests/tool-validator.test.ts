import { describe, expect, it } from 'vitest';
import {
  validateArgumentsAgainstSchema,
  validateToolCall,
  type InputSchema,
} from '@/lib/agent/tool-call/validator';

describe('validateToolCall (envelope shape)', () => {
  it('accepts name + object arguments', () => {
    const r = validateToolCall('demo_echo', { text: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('defaults missing arguments to an empty object', () => {
    const r = validateToolCall('demo_echo', undefined);
    expect(r.ok && r.value.arguments).toEqual({});
  });

  it('rejects empty or non-string names', () => {
    expect(validateToolCall('', {}).ok).toBe(false);
    expect(validateToolCall(42 as unknown as string, {}).ok).toBe(false);
  });

  it('rejects array arguments', () => {
    expect(validateToolCall('demo_echo', ['x']).ok).toBe(false);
  });

  it('rejects prototype-polluting argument keys', () => {
    // Via JSON.parse: object literals treat __proto__ specially.
    const args = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    const r = validateToolCall('demo_echo', args);
    expect(!r.ok && r.code).toBe('DANGEROUS_KEY');
  });
});

describe('validateArgumentsAgainstSchema', () => {
  const schema: InputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      count: { type: 'number' },
    },
    required: ['text'],
    additionalProperties: false,
  };

  it('accepts valid arguments', () => {
    expect(validateArgumentsAgainstSchema({ text: 'a', count: 2 }, schema).ok).toBe(true);
  });

  it('reports missing required arguments', () => {
    const r = validateArgumentsAgainstSchema({ count: 1 }, schema);
    expect(!r.ok && r.code).toBe('MISSING_ARGUMENT');
  });

  it('reports wrong argument types', () => {
    const r = validateArgumentsAgainstSchema({ text: 3 }, schema);
    expect(!r.ok && r.code).toBe('ARGUMENT_TYPE');
  });

  it('rejects unexpected arguments when additionalProperties is false', () => {
    const r = validateArgumentsAgainstSchema({ text: 'a', extra: true }, schema);
    expect(!r.ok && r.code).toBe('UNKNOWN_ARGUMENT');
  });

  it('allows unknown arguments when additionalProperties is not false', () => {
    const open: InputSchema = {
      type: 'object',
      properties: {},
    };
    expect(validateArgumentsAgainstSchema({ whatever: 1 }, open).ok).toBe(true);
  });

  it('validates array element types when items is specified', () => {
    const withItems: InputSchema = {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['paths'],
      additionalProperties: false,
    };
    expect(validateArgumentsAgainstSchema({ paths: ['a.ts', 'b.ts'] }, withItems).ok).toBe(true);
    const bad = validateArgumentsAgainstSchema({ paths: ['a.ts', 99] }, withItems);
    expect(!bad.ok && bad.code).toBe('ARGUMENT_TYPE');
  });
});
