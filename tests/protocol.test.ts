import { describe, expect, it } from 'vitest';
import {
  createError,
  createRequest,
  createSuccess,
  isRequest,
  isResponse,
} from '@/lib/protocol';

describe('protocol envelope', () => {
  it('creates unique request ids', () => {
    const a = createRequest('ping');
    const b = createRequest('ping');
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('req_')).toBe(true);
  });

  it('omits params when absent', () => {
    const req = createRequest('ping');
    expect('params' in req).toBe(false);
  });

  it('keeps params when provided', () => {
    const req = createRequest('read_file', { path: 'src/main.ts' });
    expect(req.params).toEqual({ path: 'src/main.ts' });
  });

  it('builds success and error responses sharing the request id', () => {
    const req = createRequest('exec', { cmd: 'pnpm test' });
    const ok = createSuccess(req.id, { exitCode: 0 });
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe(req.id);

    const err = createError(req.id, 'TIMEOUT', 'killed after 30s');
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('TIMEOUT');
    expect(err.id).toBe(req.id);
  });

  it('validates requests and rejects junk', () => {
    expect(isRequest(createRequest('ping'))).toBe(true);
    expect(isRequest({ id: 1, method: 'ping' })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest('ping')).toBe(false);
  });

  it('validates responses of both kinds', () => {
    expect(isResponse(createSuccess('req_1', true))).toBe(true);
    expect(isResponse(createError('req_1', 'X', 'boom'))).toBe(true);
    expect(isResponse({ id: 'req_1' })).toBe(false);
    expect(isResponse({ id: 'req_1', ok: false })).toBe(false);
    expect(isResponse(undefined)).toBe(false);
  });
});
