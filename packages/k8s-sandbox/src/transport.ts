/**
 * The exec seam Pi sees (spec §3). Everything above `select-sandbox`
 * (`run-leaf`, `run-turn`, `converge`) depends only on `SandboxTransport` and
 * never learns how bytes reach the sandbox. Implementations: `KubectlTransport`
 * (per-call kubectl exec), `GrpcRelayTransport` (added in ST3), and
 * `persistentExecInPod` (one long-lived channel, serving the file tools) — all three
 * are capped at DEFAULT_OUTPUT_CAP, each by its own mechanism (spec §8).
 */

/**
 * The result of one exec through the seam.
 *
 * `truncated` is REQUIRED, not optional. An optional field lets a fourth transport omit
 * it and read as "not truncated", silently reintroducing the divergence #180/#185 are
 * about; required, it is a compile error. The invariant `truncated === true ⇒
 * exitCode === null` is asserted for every implementation by test/conformance.ts.
 *
 * `exitCode: null` is retained on truncation for backward compatibility: every caller
 * that checks `!== 0` keeps failing closed, so there is no flag day. The flag adds
 * precision — `truncated: false` with `exitCode: null` now unambiguously means "no exit
 * status, and NOT because of our cap" (a signalled process; gRPC `end.exitCode < 0`; a
 * stream that ended without an `End` frame).
 */
export interface ExecResult {
  stdout: Buffer;
  exitCode: number | null;
  /**
   * The seam's output cap tripped (spec §8). `stdout` is incomplete and ends with
   * OUTPUT_TRUNCATED_MARKER, the producer was stopped, and `exitCode` is null.
   */
  truncated: boolean;
}

/**
 * One command run in the sandbox (`bash -c <command>`). stdout is collected and
 * returned; stderr is streamed to `onData` (with stdout) but NOT included in the
 * returned `stdout`, so file ops get clean bytes. `stdin` feeds data (e.g. base64
 * for writes); `onData` streams output for bash; `signal` aborts; `timeout` is seconds.
 */
export type ExecInPod = (
  command: string,
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds
  },
) => Promise<ExecResult>;

/** A transport-blind exec channel to one sandbox (spec §3). */
export interface SandboxTransport {
  exec: ExecInPod;
  /** Release any long-lived resource (persistent channel, connection). Idempotent. */
  close(): Promise<void>;
}

/**
 * Total returned-stdout cap per exec (spec §8, "poisoned-output defense"). Enforced by
 * ALL THREE `SandboxTransport` implementations, each by its own mechanism, which it
 * declares to the shared battery (test/conformance.ts):
 *
 *  - `KubectlTransport`     `local-kill`        SIGKILLs its `kubectl exec` client
 *  - `GrpcRelayTransport`   `remote-abort`      `Abort` → the worker kills the process group
 *  - `persistentExecInPod`  `producer-side-cap` pod-side `head -c` bounds output at the source
 *
 * On a trip each truncates, appends OUTPUT_TRUNCATED_MARKER, and sets
 * `truncated: true` with a null exit code. The battery asserts the invariant and the
 * declared mechanism for every implementation, so none can regress alone.
 *
 * The Go worker's BufferCap (remote-worker/internal/exec/runner.go) is pinned to this
 * value — change one and change the other; test/output-cap-coupling.test.ts enforces it.
 */
export const DEFAULT_OUTPUT_CAP = 8 * 1024 * 1024; // 8 MiB

/** Appended to returned stdout when the cap trips, so Pi sees the truncation. */
export const OUTPUT_TRUNCATED_MARKER = '\n[output truncated]';

/**
 * base64EncodedLength is what a write costs on the wire, EXACTLY. `createPodWriteOps`
 * sends file content as base64 in `Exec.stdin` (operations.ts), and base64 emits 4
 * bytes per 3 consumed, padding the final group — so the length is `4·⌈n/3⌉`, which is
 * up to 2 bytes more than the ×4/3 ratio suggests.
 *
 * The ratio is fine for prose and wrong for a bound: at DEFAULT_OUTPUT_CAP the two
 * differ by 1.33 bytes, and 8 MiB × 4/3 = 11184810.67 sits BELOW the real 11184812. A
 * guard written against the ratio therefore admits a ceiling that cannot actually carry
 * the largest readable file — it fails to certify the one property it exists for, at
 * exactly its own boundary. Use this instead of multiplying.
 */
export const base64EncodedLength = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/**
 * EXEC_FRAMING_HEADROOM is what an `Exec` costs BEYOND its base64 stdin: the command
 * string, the protobuf field tags and length prefixes, and `ExecRequest`'s `sandbox_id`.
 *
 * Measured, not guessed: a 4 MiB write arrived as 5592440 bytes against a base64 payload
 * of 5592408 — a delta of **32 bytes**. 64 KiB is three orders of magnitude above that,
 * which is deliberate: the command string is the only unbounded term (`base64 -d > <path>`
 * today, a few dozen bytes) and nothing in the contract caps it.
 */
export const EXEC_FRAMING_HEADROOM = 64 * 1024;

/**
 * MAX_EXEC_MESSAGE_BYTES raises gRPC's 4 MiB default receive limit, which is smaller
 * than this contract's own write path needs (#173 item 2).
 *
 * THE DERIVATION, because the number must not be arbitrary. The largest readable file
 * is DEFAULT_OUTPUT_CAP, and writing it back costs
 * `base64EncodedLength(DEFAULT_OUTPUT_CAP) + EXEC_FRAMING_HEADROOM` = 11184812 + 65536
 * ≈ 10.7 MiB of `Exec`. At the 4 MiB default, every file between ~3 MiB and 8 MiB was
 * READABLE BUT NOT WRITABLE — and Pi's Edit composes read with write, so editing one
 * succeeded at reading and then failed. 16 MiB clears that floor with ~5 MiB to spare,
 * making write capacity >= read capacity by construction. `KubectlTransport` pipes
 * base64 through `kubectl exec` stdin with no such ceiling, so this also removes a
 * divergence where the same write succeeded or failed depending on which backend was
 * leased.
 *
 * The floor is asserted against the EXACT encoded length, not the ×4/3 ratio — see
 * base64EncodedLength for why the ratio cannot certify this property at its own
 * boundary.
 *
 * BOTH ENDS MUST MOVE TOGETHER, and the worker's limit must be at least this one.
 * The relay's ingress is what rejects an oversized `ExecRequest` today, and that
 * rejection is contained to a single exec. Raising the relay alone would forward the
 * payload and move the rejection onto the worker's Attach stream, whose death takes
 * every concurrent and queued exec with it. The Go side is
 * `session.MaxRecvMsgBytes`, pinned to this value by
 * test/message-size-coupling.test.ts — change one and change the other.
 *
 * MEMORY BUDGET — raising a receive limit raises worst-case ingress buffering with it,
 * 4x here, so state it the way `BufferCap` states its own (runner.go):
 *
 *	concurrently decoding ExecRequests × MAX_EXEC_MESSAGE_BYTES
 *
 * It is a TRANSIENT, not a residency: the relay forwards `exec` to the Attach stream and
 * keeps no copy (relay.ts routeExec), so the peak is however many oversized requests are
 * mid-decode at once rather than however many execs are in flight. Nothing in the
 * contract bounds that count — the relay is single-replica and serves every harness
 * replica — so this is a ceiling to size the relay's limits against, not a proof. For
 * scale: one such request costs a quarter of the worker's own 64 MiB
 * (2 × MaxConcurrent × BufferCap) budget, and only a write near the read cap reaches it.
 *
 * Send limits need no change: grpc-js defaults max_send_message_length to -1 and
 * grpc-go defaults MaxCallSendMsgSize to MaxInt32, both effectively unlimited.
 */
export const MAX_EXEC_MESSAGE_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Ceiling on one exec when the caller names no `timeout` (spec §3; issue #182). Shared by
 * ALL THREE implementations, for the same reason DEFAULT_OUTPUT_CAP is: an exec that
 * behaves differently depending on which transport happened to serve it is a divergence
 * the caller above the seam cannot see or control.
 *
 * The three used to disagree. `KubectlTransport` and `persistentExecInPod` armed no timer
 * at all, so a command with no timeout ran unbounded; `GrpcRelayTransport` applied 120 s.
 * Pi's bash tool declares `timeout` optional and tells the model there is "no default
 * timeout", so omitting it is the ordinary case, not an edge one — the same model-issued
 * `bash` ran forever on a pod and died after two minutes through a relay.
 *
 * This is deliberately generous. It exists to stop an exec leaking a slot forever, NOT to
 * police how long a command may legitimately take: a cold `npm ci`, a full test suite or a
 * container build can all outrun a two-minute budget, and the relay's 120 s default was low
 * enough to fail those on the remote path only. Callers that know better still pass their
 * own `timeout`, and `timeout: 0` explicitly opts out (the ceiling applies only when the
 * option is absent).
 *
 * `GrpcRelayTransport` also sends this as the request's `timeout_s`, so the worker holds the
 * same budget independently. It is the only transport whose process is remote: the other two
 * time out a child in their own process, which cannot outlive the timer, whereas a harness
 * that exits mid-exec would otherwise leave a remote process with nothing left to stop it.
 *
 * Pinned for every implementation by test/conformance.ts (and, for the wire value,
 * test/grpc-relay-transport.test.ts), so none can drift back.
 */
export const DEFAULT_EXEC_TIMEOUT_S = 30 * 60; // 30 minutes
