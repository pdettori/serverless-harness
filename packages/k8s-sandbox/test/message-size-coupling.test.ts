import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE64_INFLATION, DEFAULT_OUTPUT_CAP, MAX_EXEC_MESSAGE_BYTES } from '../src/transport.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIAL_GO = resolve(REPO_ROOT, 'remote-worker/internal/session/dial.go');
const MAIN_GO = resolve(REPO_ROOT, 'remote-worker/cmd/worker/main.go');

/**
 * Loud-throw reader, same shape as output-cap-coupling's: a renamed or reformatted Go
 * constant must fail the extraction rather than limp through as NaN and pass the
 * comparison by accident.
 */
const readMaxRecvMsgBytes = (): number => {
  const src = readFileSync(DIAL_GO, 'utf8');
  const match = /MaxRecvMsgBytes = (\d+) \* 1024 \* 1024/.exec(src);
  if (!match) {
    throw new Error(
      'could not find `MaxRecvMsgBytes = N * 1024 * 1024` in dial.go — constant renamed or reformatted?',
    );
  }
  return Number(match[1]) * 1024 * 1024;
};

describe('gRPC message-size limit is pinned across the language boundary', () => {
  it("MAX_EXEC_MESSAGE_BYTES equals the Go worker's MaxRecvMsgBytes", () => {
    // The two ends must move TOGETHER. The relay's ingress limit rejects an oversized
    // ExecRequest and contains the failure to one exec; if the worker's limit were
    // lower, the relay would forward a payload the worker then refuses — on the Attach
    // stream, whose death takes every concurrent and queued exec with it and forces a
    // re-dial. A worker limit BELOW the relay's is therefore strictly worse than both
    // being at the 4 MiB default, which is why this is an equality and not a floor.
    expect(MAX_EXEC_MESSAGE_BYTES).toBe(readMaxRecvMsgBytes());
  });

  it('leaves room to write back the largest file the read path can return', () => {
    // The defect this closes: read is capped at DEFAULT_OUTPUT_CAP (8 MiB) while a
    // write costs 4/3 of the file in Exec.stdin, so at gRPC's 4 MiB default a file
    // between ~3 and 8 MiB was readable but not writable — and Pi's Edit composes read
    // with write. Asserting the RELATIONSHIP rather than the literal means bumping the
    // output cap alone cannot silently reintroduce the asymmetry.
    expect(MAX_EXEC_MESSAGE_BYTES).toBeGreaterThan(DEFAULT_OUTPUT_CAP * BASE64_INFLATION);
  });

  it('is actually applied by the worker, not merely defined', () => {
    // A constant nothing dials with is indistinguishable from no constant. main.go must
    // reach the wire through session.DialOptions, which is where the limit is attached
    // and what the contract tests exercise.
    expect(readFileSync(MAIN_GO, 'utf8')).toMatch(
      /grpc\.NewClient\(\s*relayAddr,\s*session\.DialOptions\(/,
    );
  });
});
