import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  base64EncodedLength,
  DEFAULT_OUTPUT_CAP,
  EXEC_FRAMING_HEADROOM,
  MAX_EXEC_MESSAGE_BYTES,
} from '../src/transport.js';

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
    // The defect this closes: read is capped at DEFAULT_OUTPUT_CAP (8 MiB) while a write
    // costs base64 of the file in Exec.stdin, so at gRPC's 4 MiB default a file between
    // ~3 and 8 MiB was readable but not writable — and Pi's Edit composes read with
    // write. Asserting the RELATIONSHIP rather than the literal means bumping the output
    // cap alone cannot silently reintroduce the asymmetry.
    //
    // Two things this bound gets right that `DEFAULT_OUTPUT_CAP * 4/3` did not. The
    // encoded length is EXACT: 4·⌈n/3⌉ is 11184812 where the ratio gives 11184810.67, so
    // the ratio's bound sat 1.33 bytes BELOW the smallest payload it exists to admit and
    // would have passed a ceiling of 11184811 that cannot carry an 8 MiB file. And the
    // headroom term is asserted rather than merely claimed in prose: without it, a
    // ceiling with zero room for the command string or protobuf framing satisfies the
    // floor while contradicting the constant's own documented derivation.
    expect(MAX_EXEC_MESSAGE_BYTES).toBeGreaterThanOrEqual(
      base64EncodedLength(DEFAULT_OUTPUT_CAP) + EXEC_FRAMING_HEADROOM,
    );
  });

  it('encodes lengths the way base64 actually does, padding included', () => {
    // base64EncodedLength is load-bearing for the floor above, so pin it directly rather
    // than trusting the formula: Node's own encoder is the oracle.
    for (const n of [0, 1, 2, 3, 4, 3000, DEFAULT_OUTPUT_CAP]) {
      expect(base64EncodedLength(n)).toBe(Buffer.alloc(n).toString('base64').length);
    }
  });

  it('is actually applied by the worker, not merely defined', () => {
    // A constant nothing dials with is indistinguishable from no constant. main.go must
    // reach the wire through session.DialOptions, which is where the limit is attached
    // and what the contract tests exercise.
    //
    // `[^)]*` for the address argument, NOT the literal `relayAddr`: pinning a local
    // variable name would make renaming it report "the option is not applied" while the
    // option is in fact applied — a false negative on the one assertion whose entire job
    // is telling applied from merely defined. The requirement is that the DialOptions
    // call sits inside NewClient's arguments; what the address is called is not this
    // test's business. A bare /session\.DialOptions\(/ would be too loose in the other
    // direction, since main.go's own comment names the function.
    const mainGo = readFileSync(MAIN_GO, 'utf8');
    if (!/grpc\.NewClient\([^)]*session\.DialOptions\(/.test(mainGo)) {
      // Loud throw naming the cause, like readMaxRecvMsgBytes above: a bare toMatch
      // failure here reads as "the limit is not applied" when the likelier truth is that
      // the dial was restructured and this assertion needs re-aiming.
      throw new Error(
        'main.go does not dial through session.DialOptions — either the receive limit is ' +
          'no longer applied in production (the defect this guards), or the dial was ' +
          'restructured and this assertion needs updating. Check which before "fixing" it.',
      );
    }
  });
});
