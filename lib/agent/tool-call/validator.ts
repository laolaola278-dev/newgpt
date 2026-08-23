/**
 * Validation for parsed tool calls.
 *
 * Two layers:
 *  1. envelope shape — strict top-level fields, sane types;
 *  2. arguments schema — a deliberately tiny JSON-Schema subset
 *     (type / properties / required / additionalProperties). No dependency,
 *     no dynamic evaluation.
 */

import type { ToolCall } from './types';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const ALLOWED_TOP_LEVEL = new Set(['name', 'arguments']);

export function validateToolCall(
  rawName: unknown,
  rawArgs: unknown,
): ValidationResult<Pick<ToolCall, 'name' | 'arguments'>> {
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return { ok: false, code: 'INVALID_NAME', message: '"name" must be a non-empty string' };
  }
  if (rawArgs === undefined || rawArgs === null) {
    return { ok: true, value: { name: rawName, arguments: {} } };
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, code: 'INVALID_ARGUMENTS', message: '"arguments" must be an object' };
  }
  for (const key of Object.keys(rawArgs as object)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return { ok: false, code: 'DANGEROUS_KEY', message: `illegal argument key "${key}"` };
    }
  }
  return {
    ok: true,
    value: { name: rawName, arguments: rawArgs as Record<string, unknown> },
  };
}

// ── minimal schema subset ──────────────────────────────────────────────────

export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface SchemaProperty {
  type: JsonType;
  description?: string;
  items?: { type: JsonType };
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

export function validateArgumentsAgainstSchema(
  args: Record<string, unknown>,
  schema: InputSchema,
): ValidationResult<true> {
  if (schema.type !== 'object') {
    return { ok: false, code: 'BAD_SCHEMA', message: 'root schema must be an object' };
  }
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in args)) {
      return { ok: false, code: 'MISSING_ARGUMENT', message: `missing required argument "${key}"` };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        return { ok: false, code: 'UNKNOWN_ARGUMENT', message: `unexpected argument "${key}"` };
      }
      continue;
    }
    if (!matchesType(value, prop.type)) {
      return {
        ok: false,
        code: 'ARGUMENT_TYPE',
        message: `argument "${key}" must be of type ${prop.type}`,
      };
    }
  }
  return { ok: true, value: true };
}
