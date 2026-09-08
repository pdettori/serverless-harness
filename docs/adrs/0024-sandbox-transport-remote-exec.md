# ADR-0024: Remote sandbox exec over a worker-dialed gRPC stream, contract as language-neutral Protobuf

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Serverless Harness team
- **Spec:** [`../specs/2026-07-08-sandbox-transport-grpc-design.md`](../specs/2026-07-08-sandbox-transport-grpc-design.md)

## Context

The harness runs every Pi tool call inside a sandbox pod via `kubectl exec`, so it must dial _into_ the pod through the kube API. That rules out any sandbox behind NAT, on-prem, on a laptop, or in another cloud — and blocks the top driver, bring-your-own (untrusted third-party) sandboxes. Reaching those requires inverting connectivity (the sandbox dials _out_) with a contract that is language-neutral (any runtime can host a worker) and firewall-friendly (one outbound TLS connection on `:443`), without touching the Pi loop, the session backend, or the leaf queue. An earlier revision of this PR got the outbound-dial direction right but carried the RPC over Redis Streams behind a TypeScript interface — locking workers to TS via JSON+base64 frames and forcing Redis (a port `:443`-only egress commonly blocks) into the exec path.

## Decision

We will delegate remote command execution over a single **worker-dialed gRPC bidirectional `Attach` stream (HTTP/2 on `:443`)**, define the contract as a **Protobuf IDL (`sandbox/v1`)** rather than a language-specific interface, and land both paths behind the existing **`SandboxTransport`** seam — `KubectlTransport` (today's in-cluster fast path, renamed) and a new `GrpcRelayTransport` are two implementations of one interface. A **single-replica, presence-only** in-cluster relay bridges the worker's outbound stream to the harness's in-cluster `SandboxExec` calls and mirrors connected workers into the existing Redis sandbox pool; matching stays in `select-sandbox`. One **Go reference worker** ships as the honest proof the contract is genuinely language-neutral.

### Alternatives considered

- **Redis-Streams transport + TS `@sh/sandbox-worker`** (this PR's prior revision) — rejected: TS lock-in through JSON+base64 frames, and Redis-on-its-port is blocked by `:443`-only egress while forcing a Redis dependency into exec.
- **Connect / HTTP-1.1 fallback** — rejected: full-duplex bidi needs HTTP/2 regardless, so Connect adds a second toolchain for no gain on the streaming core.
- **Relay owning matching / multi-replica HA** — deferred: a single replica needs no presence glue beyond the pool mirror, and matching stays in the existing pool.

## Consequences

- Positive: a sandbox can live anywhere behind one outbound `:443` connection with no inbound rules; any gRPC-capable language can host a worker; the in-cluster `kubectl-exec` path is unchanged; everything above `select-sandbox` stays transport-blind; the frame semantics (`req_id` correlation, at-least-once + dedup, dual-ended timeout, per-exec output cap) carry over verbatim.
- Negative / accepted cost: a new in-cluster relay component plus a Protobuf/gRPC toolchain; single-replica relay means a restart drops all parked streams and fails in-flight execs (recovery is leaf retry — no mid-exec durability); exactly-once is impossible — at-least-once + dedup only, with partial-write risk on crash.
- Follow-up owed: untrusted-BYO SPIFFE/mTLS on the same `Attach` endpoint; multi-replica relay HA; private-mesh reachability (Headscale / WireGuard); additional-language workers; HTTP/1.1-only proxy traversal — all additive behind the same seam.

## Revisions

### 2026-08-28 — `req_id` uniqueness (issue #179)

The original decision left `req_id` as "monotonic", which was implemented as a
module-scope counter — per process. `select-sandbox` shares a sandbox across replicas by
design (`max-scale: 5`, lease cap 20), and the relay keys per-exec sinks by `req_id`
within a session, so two replicas emitting `1, 2, 3…` could silently detach one caller
(it hangs to its deadline) and interleave both execs' output into the other.

**Decided:** ids carry a 21-bit per-process random salt in the high bits and a 32-bit
counter in the low bits. The maximum reachable id is `(2^21 − 1)·2^32 + (2^32 − 1) =
9007199254740991`, exactly `Number.MAX_SAFE_INTEGER` — required because the generated
TypeScript maps `uint64` through `longToNumber`. That is zero headroom, not a margin: the
layout lands precisely on the boundary, so widening the salt to 22 bits or the counter to
33 does not consume slack — it immediately crosses into precision loss and silent id
aliasing, where two different execs collapse onto one number. Uniqueness is probabilistic
in the salt (birthday collision ≈ 4.8e-6 across five replicas — `C(5,2)/2^21`) and exact in
the counter.

**Rejected:** widening the generated mapping to `string`/`Long` with a UUID — correct but
it reopens the `sandbox/v1` contract and the Go worker's cache key for a failure mode the
salt already closes. Also rejected: caller-scoped correlation at the relay
(`(callerId, reqId)`), which needs a proto field and leaves the worker's dedup cache still
keyed on a non-unique id.

**Consequence:** the relay now rejects a duplicate in-flight `req_id` rather than
overwriting the live sink, converting a silent misroute into a loud error.

### 2026-08-28 — the output cap moves onto the seam, but covers two of three transports

§8 always worded the cap as a harness-level property, but only `GrpcRelayTransport`
implemented it; `KubectlTransport` buffered without bound behind a `TODO(M3)`.

**Decided:** both **per-call** transports enforce it, the constant and marker live on the
seam (`transport.ts`), and the shared conformance battery asserts it for both — because a
cap on one implementation makes the transports distinguishable to Pi, which contradicts the
swappability the epic's driver #2 claims.

**Superseded by the 2026-08-30 revision below.** **Still not a seam-wide guarantee.** There
is a third `SandboxTransport`,
`persistentExecInPod`, and it remains uncapped; `extension.ts` gives it
Read/Write/Edit/Ls/Find, so the file-reading tools are exactly the ones running without a
cap. The battery therefore covers two of three implementations, and Pi can still tell the
backends apart on output volume. Capping the Read path is a production behaviour change and is tracked
separately. What _is_ closed here is the damaging consequence: because that transport falls
back to the capped `KubectlTransport` on channel death, a truncated read could reach Pi's
Edit tool and be written back over the file, so `createPodReadOps.readFile` now throws
instead of returning bytes it cannot vouch for.

### 2026-08-30 — the cap becomes seam-wide; truncation becomes explicit (issues #180, #181, #185)

The 2026-08-28 revision left the cap covering two of three transports and left truncation
represented only as a null exit code — a value that also means "signalled, no status".

**Decided:** `ExecResult` carries a required `truncated: boolean`, with the invariant
`truncated === true ⇒ exitCode === null`. Required rather than optional, so a fourth
transport cannot omit it and read as "not truncated" — that silent divergence is the defect.
`exitCode` stays null on truncation, so every caller that checks `!== 0` keeps failing
closed and there is no flag day.

**Decided:** `persistentExecInPod` is capped **in the pod**, by a `head -c <cap + 1>` stage
in `wrapCommand`'s pipeline. This caps raw bytes before base64 inflation, so the trip point
matches the per-call transports exactly; a client-side byte count would have capped content
at cap × 3/4, a weaker form of the same distinguishability. It also bounds
`FrameParser.push`, which re-stringifies its buffer per chunk and so grows quadratically.
`PIPESTATUS[0]` still indexes the command, and the resulting SIGPIPE 141 is ignored because
truncation is detected by length.

**Consequence, and the cost accepted:** a file above the cap is now **unreadable** through
Read/Edit — not merely truncated. `pi-fork`'s `read.ts` reads the whole file before applying
`offset`/`limit`, so the paging its own tool description advertises cannot reach past the
cap either. Accepted because Pi clips Read output to 2000 lines / 50 KB regardless, so what
is lost is a path returning bytes the model never saw, at the cost of harness memory and
quadratic parse time. `readFile` throws naming the cap, the path, and a `bash`+`sed`
range read, plus the file size when a truncation-path `stat` can supply it.

**Decided:** `createPodBashOps` returns **137** on truncation. 128+9 is the conventional
SIGKILL status and is accurate — the command was killed by signal 9 at the cap — and it
routes through Pi's own failure path, which appends the streamed output tail, so the model
gets both facts. **Rejected:** a bare throw, which loses the tail (`bash.ts` appends output
only for `aborted`/`timeout:` messages); patching `pi-fork` to carry both, which spans two
repos for a wording gain; and making truncation reject at the transport level, which
contradicts §8's truncate-and-surface contract and would change `GrpcRelayTransport`'s
behaviour, unchanged since ST3.

**Decided:** the battery's `producerStopped(): boolean` becomes
`producerStop(): ProducerStop`, a four-value mechanism each transport declares and the
battery pins. **Rejected:** a "was it remote?" boolean — it would assert `false` for both
kubectl paths and so discard the coverage that `child.kill` is actually called, which is
load-bearing (with it removed, deleting `child.kill` still passed). **Rejected:** making the
kubectl paths genuinely stop the remote producer by recording a pid and issuing a second
`kubectl exec`, which adds a wrapper and an extra exec to every call, with new pid-file
races, to defend a case only an already-hostile sandbox reaches — #57's territory.

**Consequence:** all three implementations run one battery. `persistentExecInPod` declares
`streams: false`, since it is request/response over one multiplexed channel; declared rather
than silently skipped, because quietly omitting a case for one implementation is how the
#185 asymmetry survived. Its pod-side pipeline is proved against a real `bash`
(`framing.test.ts`), not by the hermetic fake that simulates it.

### 2026-09-06 — one default exec timeout across all three transports (issue #182)

§8 recorded "no default deadline on the kubectl path" as an accepted divergence: the two
kubectl transports armed no timer when the caller named no `timeout`, while
`GrpcRelayTransport` applied `DEFAULT_DEADLINE_MS` (120 s). The same model-issued `bash`
therefore ran unbounded on a pod and died after two minutes through the relay, decided by
which backend `select-sandbox` happened to lease — invisible to callers above the seam, and
invisible to the conformance battery, whose timeout case only ever passed an explicit
`timeout`.

**Decided:** `DEFAULT_EXEC_TIMEOUT_S` (30 minutes) in `transport.ts`, applied by all three
implementations when no `timeout` is given, and sent as the gRPC request's `timeout_s` so
the worker holds the same budget independently. An explicit `timeout: 0` means unbounded on
both ends. The value is deliberately generous — it exists so an exec cannot leak a sandbox
slot forever, not to bound legitimate work.

**Rejected:** giving `KubectlTransport` the relay's 120 s. It reads as the obvious fix but
inverts the evidence: Pi's bash tool declares `timeout` optional and documents "no default
timeout", and Pi's own local executor arms a timer only when one is set — so the kubectl
transports matched Pi and the relay was the outlier. Adopting 120 s everywhere would make
all three contradict the description the model reads, and start failing a cold `npm ci` or a
full test suite on every path.

**Rejected:** removing the relay's default. It restores parity with Pi, but an unbounded
remote exec can hold one of the worker's `MaxConcurrent` slots with no client-side recovery,
which is the hang §8's dual-ended timeout exists to prevent.

**Rejected:** keeping the divergence and merely documenting it. It leaves an exec's fate
depending on which transport served it, for no benefit once a single generous ceiling
satisfies both sides.

**Consequence:** the dual-ended timeout is now genuinely dual-ended for the unspecified
case. Previously the request carried `timeout_s: 0`, and the worker arms its timeout only
when `TimeoutS > 0` (`runner.go`), so the harness held the ceiling alone — a harness that
exited, a dropped connection, or an `Abort` that never landed would leave the remote process
running with nothing left to stop it. Both defaults are pinned by the shared battery, and
the wire value by `grpc-relay-transport.test.ts`, since a transport-blind battery cannot
distinguish a ceiling both ends enforce from one only the harness does.

### 2026-09-07 — the worker declares its own truncation on the wire (issue #189)

The 2026-08-30 revision above made truncation explicit on the seam and asserted
`truncated === true ⇒ exitCode === null` for all three transports. One producer was still
outside that guarantee: the Go worker's own `BufferCap`. On the non-streaming path it dropped
output past 8 MiB and then sent `End` with the command's real exit code, so
`GrpcRelayTransport` resolved `{ truncated: false, exitCode: 0 }` over cut output.

**The equality of the two caps is what made it silent.** `BufferCap` and
`DEFAULT_OUTPUT_CAP` are both 8 MiB, and the harness trips on `bytes > cap` — strictly
greater — so a worker delivering exactly the cap looks complete. A difference of one byte in
either direction would have exposed it.

**Decided:** `bool truncated = 3` on `End`, **scoped to stdout**. The worker keeps sending the
command's **real** `exit_code`; the transport applies the seam invariant. Splitting it that way
keeps the wire honest for any client that wants the status, and keeps
`truncated ⇒ exitCode === null` in the one place that owes it. Inside the worker the count
reaches the frame through a **required**
`Sink.Dropped` method, not an optional extension, for the same reason §8's `truncated` is
required rather than optional: an omitted report reads as "nothing dropped", which is the
defect one layer down. Required, a `Sink` that forgets it does not compile.

**Rejected:** making the caps deliberately unequal so the harness's cap always trips first
(worker `BufferCap` = harness cap + one chunk). No proto change, and it does fix our client —
but it fixes only clients whose cap is below `BufferCap`. `sandbox/v1` is a language-neutral
contract for third-party workers and clients, so a fix that depends on the harness's private
constant is not a contract fix. It also converts a stated invariant
(`output-cap-coupling.test.ts` pins the two as equal) into a stated offset, which is harder
to reason about for no gain once the flag exists.

**Rejected:** rejecting `streaming: false` at the relay, since our client never sets it. It
narrows the surface without fixing the contract, and it breaks legitimate non-streaming
third-party clients — the mode exists in the proto and `read`/`write` are exactly what it is
for.

**Scope caveat, found in review.** The worker caps stdout and stderr **separately**, each at
`BufferCap`, but the seam's cap covers stdout alone — `grpc-relay-transport.ts` excludes stderr
from both its buffer and its byte count. The first implementation summed both streams into the
flag, which would have made a cut stderr beside a whole stdout resolve as
`{exitCode: null, truncated: true}` with the marker glued onto output that was never cut: the
mirror of this defect, under-reporting traded for over-reporting, and it discards a valid exit
status. The flag is therefore stdout-only, using the transport's own `!= STDERR` predicate so
both ends read `STREAM_UNSPECIFIED` as stdout identically. A truncated stderr gets **no** wire
signal — a second truncation concept for bytes the seam does not return would buy nothing — and
is logged by the worker instead, since going entirely silent is what this issue was about.

**Consequence:** the defect is unreachable from any first-party path — `grpc-relay-
transport.ts` hardcodes `streaming: true` — so a scripted `End{truncated: true}` in
`grpc-relay-transport.test.ts` is what makes it observable, alongside Go unit tests on the
runner's accounting and the session's frame. Equality of the two caps is still pinned, but
it now pins memory parity rather than detectability, and the test says so.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
