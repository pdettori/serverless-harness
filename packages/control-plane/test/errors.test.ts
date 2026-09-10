import { describe, expect, it } from 'vitest';
import { CpError, statusFor, writeError, type CpErrorCode } from '../src/errors.js';

// Every code spec §9.1 names, plus the four this plan adds (gaps #7, #8): the list is written out
// rather than derived from the STATUS map, so deleting a mapping fails here instead of shrinking
// the thing under test along with the test.
const ALL_CODES: CpErrorCode[] = [
  'invalid_json',
  'invalid_request',
  'token_required',
  'token_invalid',
  'token_expired',
  'subject_conflict',
  'unauthorized',
  'forbidden',
  'session_not_found',
  'session_mismatch',
  'credential_required',
  'credential_ambiguous',
  'credential_not_found',
  'credential_unavailable',
  'endpoint_unresolved',
  'authorization_pending',
  'redis_unavailable',
  'internal_error',
];

describe('statusFor', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ALL_CODES) {
      expect(statusFor(code), code).toBeGreaterThanOrEqual(400);
    }
  });

  it('uses the statuses spec §9.1 fixes', () => {
    expect(statusFor('token_required')).toBe(401);
    expect(statusFor('token_invalid')).toBe(401);
    expect(statusFor('token_expired')).toBe(401);
    expect(statusFor('unauthorized')).toBe(401);
    expect(statusFor('forbidden')).toBe(403);
    // 404, not 403, for another user's session: a 403 is an existence oracle (spec §8.1).
    expect(statusFor('session_not_found')).toBe(404);
    expect(statusFor('session_mismatch')).toBe(400);
    expect(statusFor('subject_conflict')).toBe(400);
    expect(statusFor('credential_required')).toBe(400);
    expect(statusFor('credential_ambiguous')).toBe(400);
    expect(statusFor('endpoint_unresolved')).toBe(400);
    expect(statusFor('credential_unavailable')).toBe(503);
    expect(statusFor('redis_unavailable')).toBe(503);
    expect(statusFor('authorization_pending')).toBe(428);
  });
});

/** Minimal ServerResponse stand-in: records the status and the single written body. */
function fakeRes() {
  const calls: { status?: number; headers?: unknown; body?: string } = {};
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: unknown) {
      calls.status = status;
      calls.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body?: string) {
      calls.body = body;
      return res;
    },
  };
  return { res, calls };
}

describe('writeError', () => {
  it('writes the repo-standard body shape', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new CpError('credential_required', 'no inference credential'));
    expect(calls.status).toBe(400);
    expect(calls.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(calls.body!)).toEqual({
      error: 'credential_required',
      message: 'no inference credential',
    });
  });

  it('includes sessionId only when the error carries one', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new CpError('session_not_found', undefined, 'sid-1'));
    expect(JSON.parse(calls.body!)).toEqual({ error: 'session_not_found', sessionId: 'sid-1' });
  });

  it('maps an unknown throwable to internal_error without leaking its message', () => {
    const { res, calls } = fakeRes();
    writeError(res as never, new Error('ECONNREFUSED redis://10.0.0.1:6379 password=hunter2'));
    expect(calls.status).toBe(500);
    // The message is deliberately dropped: an arbitrary throwable's text can carry connection
    // strings or a presented token, and this body goes to an arbitrary caller.
    expect(JSON.parse(calls.body!)).toEqual({ error: 'internal_error' });
  });

  it('does nothing once headers are already sent', () => {
    const { res, calls } = fakeRes();
    res.headersSent = true;
    writeError(res as never, new CpError('forbidden'));
    expect(calls.status).toBeUndefined();
  });
});
