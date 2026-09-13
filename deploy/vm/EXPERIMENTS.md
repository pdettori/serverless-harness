# P6 VM experiments — E8 (density) and E9 (tier comparison)

Results appended by `e8-density.sh` and `e9-tiers.sh`. Newest last.

## What these numbers are, and are not

**Two axes, never conflated (spec §5.1):**

- **Concurrent in-flight turns** — the resource-consuming quantity. This is the only thing a
  knee applies to, and the only thing E8 measures.
- **Sessions addressable** — a Redis capacity statement. Not a density claim, not measured here.

**Every knee is a floor.** `detectKnee` reports the highest rung that was still healthy among
the rungs that were run. If the top rung was healthy, the number is the ladder's limit, not the
machine's. No record here says "maximum".

**Healthy** means p95 within `DEGRADE_X` (default 2) of that arm's own `c=1` baseline, with
patience 2 — the same criterion `experiments/src/sharing.ts` applies to E6, so E6, E8, and E9
records are in the same units.

## What every E8 run record must carry (§5.2, §5.7)

This fourteen-field shape describes **E8's** records only — see the note at the end of this
section for what an E9 record actually contains. A missing E8 field is not a result:

| Field               | Why it is load-bearing                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `duty_basis`        | One §2.3 row, taken whole. A blend implies a wrong sandbox count.                                                       |
| `conns_per_turn`    | What the driver actually does (one connection per turn) — see the note below.                                           |
| stub profile        | Half the claim. ttft, token delay, output tokens, tool-call rate.                                                       |
| `loop_lag_p99`      | Attributes a knee to worker CPU / socket multiplexing.                                                                  |
| `rss_bytes`         | Memory per live session.                                                                                                |
| `file_op_ms`        | The relay round trip.                                                                                                   |
| `sandbox_cpu`       | `bash -c` churn across the pool.                                                                                        |
| `lease_saturation`  | An under-provisioned pool, which reads exactly like worker saturation.                                                  |
| `over_admission`    | Bounds IPC staleness; self-correcting, so it is a diagnostic not a failure.                                             |
| `spurious_refusals` | Refusals the next `load` convicted. Attributes a `spurious_429` to staleness.                                           |
| `spurious_429`      | **The dangerous one.** Refusals truncate a rung, so the knee reads early.                                               |
| `attempts`          | Total requests issued at this rung — the denominator for the success rate.                                              |
| `ok_n`              | 200-coded requests at this rung — the numerator, and what `p50`/`p95` are computed over.                                |
| `contention_load1`  | 1-minute load average, a contention PROXY (not a generator-specific measurement) — see "Where the generator ran" below. |

`generator_placement` (on-box/off-box) is recorded once **per run**, not per rung, in the
run-summary prose rather than this per-rung JSON shape — see "Where the generator ran" below.

### `p50`/`p95` are computed over successes only, and there is a floor below which a rung is not a result

A latency sample that mixes fast failures (a refused or timed-out request returns in a fraction
of a real response's time) with genuine responses is not a latency distribution. Sorted
ascending, the failures pile up at the bottom of the sample, so the **naive** p95 taken over
every row — successes and failures together — is really the successes' own
`(0.95 - f) / (1 - f)` quantile, where `f` is the failure fraction. At `f = 0.05` the shift is
negligible (the effective quantile is ~0.947). At `f = 0.5` the naive "p95" is actually the
successes' own **p90** wearing a p95 label — a materially different number reported under the
wrong name. See `task-3-report.md`'s "Final review fix — part 2" section for the worked
numeric example. Both drivers now filter to `ok_n`/200-coded rows before computing `p50`/`p95`;
`attempts` and `ok_n` (E8) or `attempts` and `non200` (E9, §below) are recorded precisely so this
filtering is auditable from the record itself, not merely asserted by the driver's prose.

**Success-rate floor: 0.95.** Below a 95% success rate at a rung, that rung is not a capacity
result and must not be quoted as one, even though the (now-filtered) p95 and the throughput
figure will both still look healthy — throughput saturates at whatever the arm actually
completed, and the filtered p95 by construction excludes every failure, so neither number is
sensitive to a failure storm. 0.95 is chosen, not derived, from the quantile-shift arithmetic
above: at `f = 0.05` the p95 shift is negligible (~0.3 points of quantile), so a rung just at the
floor still reports an honest p95; the floor exists to catch rungs well past that, where `f` is
large enough to materially relabel a lower quantile as p95. Both drivers WARN (not `ko`) when a
rung falls below this floor — a WARN, not a hard failure, because a low success rate at one rung
of a ladder is informative (it is itself part of what the ladder is measuring, e.g. an
admission-control knee) and should not abort a run that would otherwise produce useful rungs
above or below it; the existing `spurious_429`/`non200` WARNs already cover the mechanism, this
floor generalizes the same signal to any failure mode (a 500/503/000 storm, not only 429s) and
gives it an explicit, comparable numeric line rather than leaving "some failures happened" as
the only signal.

`conns_per_turn` records an observation, not a knob: both drivers leave `SH_ROUTING_POLICY` at
its `leastInFlight` default (`deploy/vm/env/supervisor.env.example:7`), under which routing
decides per request, not per session, so there is no session affinity for a per-turn connection
to defeat — one connection per turn is simply what `vm_turn` (`lib-vm.sh`) does. Exercising
`stickyBySession`'s session affinity is a separate, not-yet-covered gap, not something this field
or either driver's rung loop measures.

### Two of these columns are permanently `NaN` — this is not a missing run, it is a missing sensor

Of the fourteen fields above, **nine** are real, load-bearing telemetry every **E8** run record
actually carries: `loop_lag_p99`, `rss_bytes`, `sandbox_cpu`, `over_admission`,
`spurious_refusals`, `spurious_429`, `attempts`, `ok_n`, `contention_load1`. The other two,
`lease_saturation` and `file_op_ms`, will
read `NaN` in **every E8 record**, on any VM, no matter how it is provisioned — not because the
run failed to collect them, but because nothing in this repository computes them.
`harness/src/sandbox-lease.ts` derives a lease _count_ from an array its caller already holds; it
keeps no pool-wide state a supervisor could expose as a saturation ratio. No file-op p95 counter
exists anywhere in `harness/src` or `packages/k8s-sandbox/src` either. A future change could add
both — this file does not claim the gap is permanent architecture, only that it is real today —
but until one does, `lease_saturation` and `file_op_ms` are not measurements this driver declined
to make; they are measurements this codebase cannot yet make.

**Read every E8 bound sentence in this file accordingly.** When an E8 run record says "the bound
observed at: worker CPU / memory / admission-control / unattributed", that verdict is reached by
checking only the six real columns — it is never checked against `lease_saturation` or
`file_op_ms`, because there is nothing there to check. So "unattributed" does **not** mean "no
tier is responsible"; it means "of the six tiers we can see, none crossed its threshold." An
under-provisioned sandbox-pool tier or a slow relay round trip could be the actual cause of a
knee in this file and would show up as `unattributed` here, indistinguishable from a genuinely
even, non-bottlenecked run. Do not read `unattributed` as an exoneration of the lease/relay
tiers — read it as `unattributed (lease-pool and relay tiers unmeasured)`. Every claim sentence
E8 emits should be read with that qualifier whether or not the driver's own prose spells it out
at the point the sentence is written.

**E9's records do not have the attribution shape above at all — they carry none of the nine
attribution/basis/stub fields, not even as `NaN`.** `e9-tiers.sh` emits one point per rung as
`{c, throughput, p95Ms, attempts, non200, contention_load1}` (`deploy/vm/e9-tiers.sh`'s `run_arm`,
see the `points` assembly near the end of its rung loop) — `attempts` and `non200` (not `ok_n`: E9
records the failure count directly, since its existing non200>0 WARN already worked in those
terms) are carried per-point for the same success-rate-floor auditability as E8's
`attempts`/`ok_n`; `contention_load1` is carried per-point for the same reason it is carried in
E8's records (see "Where the generator ran" below) — it is not part of the attribution shape, it
is the same box-level contention proxy added independently of it. The one time `e9-tiers.sh` reads
`$METRICS_BASE/metrics` at all (in its PIN 2
pre-flight check) is to check the VM arm's `.env.ANTHROPIC_BASE_URL` matches the pinned stub, not
to sample any attribution counter — so none of the six real E8 columns, `lease_saturation`, or
`file_op_ms` are sampled, recorded, or NaN'd out for E9; they are simply absent from the JSON.
`conns_per_turn` and
`duty_basis` are still recorded for an E9 run, once in the surrounding run-record prose (§5.2's
other requirement), not per-point in the JSON. Do not read an E9
record's silence on, say, `spurious_429` as "zero refusals were observed and confirmed" — E9
never samples that column, so its absence means "not measured," not "measured and clean." Zero
and absent are opposite claims; only E8 records can make the former.

## Where the generator ran, and how busy the box was (final review fix, part 3, items B2–B4)

The load generator **is** `e8-density.sh`/`e9-tiers.sh` themselves — every `vm_turn` call in the
rung loop originates from wherever the driver process itself is running. Before this item, that
fact was invisible in the record: a run co-located with the supervisor it drives competes with
that supervisor for the same CPU the run is trying to measure, and nothing in the output said so.
Two fields close that gap, and a documentation requirement closes a third.

### `generator_placement` — derived, not declared, once per run per arm

`generator_placement()` (`lib-vm.sh`) classifies a base URL as **on-box** when it is loopback
(`127.0.0.1`, `localhost`, `::1`) and **off-box** otherwise. This is a derivation, not a flag
someone sets: curl can only reach a loopback address when the caller and the callee share a
machine, so the address itself is the proof, not a claim about it. `e8-density.sh` records one
`GENERATOR_PLACEMENT` (from `$BASE`); `e9-tiers.sh` records one per arm (`$VM_BASE`, `$KSVC_URL`),
since the same generator process can be on-box relative to one arm and off-box relative to the
other — a `$VM_BASE` on loopback is common, a `$KSVC_URL` on loopback essentially never happens
(cluster addresses are not loopback). Recorded once per run, in the run-summary prose, because
placement does not change mid-ladder — a per-rung field would only repeat the same value.

### `contention_load1` — a proxy, recorded per rung, not a generator-specific measurement

Each rung also records `contention_load1`, the 1-minute load average (`uptime`) of whichever box
the driver call executes on, sampled fresh at the end of that rung. This is **not** scoped to the
generator's own process, the supervisor's own process, or any single tier — it is whatever else is
running on that box, which is exactly the point: a co-located generator that drives its own
supervisor's load average up during a high-`c` rung will show it here, so that run cannot silently
masquerade as a clean one just because throughput and the (failure-filtered) `p95` still look
healthy. Label it as a proxy when quoting it, never as a precise attribution — it says "the box was
busy," not "the generator caused it" or "the supervisor caused it." 1-minute load average was kept
as the cheapest honest option available without a new dependency (`uptime` exists on every
platform this repo already targets, Linux and macOS/BSD alike, and needs no counter this codebase
would have to add) rather than argued away in favour of something narrower like a per-process CPU
sample, which would need `/proc` (Linux-only, and this repo's own dev environment is macOS) or an
additional tool. `e9-tiers.sh` records it per arm per rung, since the two arms can be on different
boxes and can carry different contention.

### The authoritative run puts the generator off-box, on the same subnet

**An on-box run (`generator_placement: on-box`) is a caveated result, not an equivalent one.**
The authoritative measurement path for both E8 and E9 runs the generator on a separate machine, on
the same subnet as the arm(s) it drives, so the generator's own curl/fork/exec overhead and the
supervisor's/ksvc's own CPU never compete for the same core — B1's `vm_turn` rewrite
(`lib-vm.sh`) already removed the generator's own _process-count_ overhead per turn, but it cannot
remove the fact that an on-box generator still shares a CPU budget with the thing it is measuring.
A run recorded with `generator_placement: on-box` should be read, and cited, with that caveat
attached; it is informative (useful for local iteration, or when no second machine is available)
but is not interchangeable with an off-box run when the two disagree.

**If off-box is genuinely impossible, `taskset` (Linux) or an equivalent cpuset/cgroup pin is the
documented fallback** — pin the generator process to CPUs the supervisor's/ksvc's own workers do
not use, so contention becomes bounded and visible (via `contention_load1` above) rather than
silently traded for a faster loopback round trip. This is **not implemented** by either driver:
a correct implementation is not the "genuinely small" case where implementing beats documenting —
it would need to know, per platform and per deployment (systemd unit vs. ad hoc shell, kind vs. a
real VM), which CPUs are already claimed by the supervisor or by Knative's own control-plane pods,
which this repository does not currently expose anywhere a driver could read it, and getting that
wrong (pinning the generator onto a CPU the supervisor also uses) would be worse than not pinning
at all — a false sense of isolation. Documenting the requirement, so a future run configuration
knows to reach for `taskset -c <cpu-list>` or a systemd `CPUAffinity=` setting explicitly, is the
deliverable here.

## Duty bases (spec §2.3) — take a row whole

| Basis     | Workload                                     | Duty          | Implied sessions/sandbox |
| --------- | -------------------------------------------- | ------------- | ------------------------ |
| `e6-ocp`  | real Archetype-A code review (L0/L1/L2), OCP | 0.061–0.079   | 12.6–16.5                |
| `e6-kind` | same workload, kind                          | 0.042–0.051   | 19.7–24.0                |
| `e7`      | `E7_REFS` mixed-ref converge                 | 0.021 / 0.035 | 28.6–47.6                |

`N ≈ 1/duty`. P6 provisions from `e6-ocp`. `experiments/src/basis.ts` throws on a blend, so this
table is enforced rather than merely documented. Sources, cited by line so a future edit to
`deploy/knative/EXPERIMENTS.md` can be checked against these numbers rather than trusted blind:
`e6-ocp` → `deploy/knative/EXPERIMENTS.md:88-94`; `e6-kind` → `deploy/knative/EXPERIMENTS.md:76-80`;
`e7` → `deploy/knative/EXPERIMENTS.md:121,161`. (`deploy/knative/EXPERIMENTS.md` is a different
file from this one — it holds E1/E3/E4/E6/E7 Knative-only results; this file, `deploy/vm/EXPERIMENTS.md`,
holds P6's VM results. Always cite the directory, not just the filename.)

## Runs

**No live run has been recorded in this file yet.** `e8-density.sh` and `e9-tiers.sh` were
authored and structurally tested (§5.6/§5.7's TDD gates) in an environment with no VM and no
Kubernetes cluster — a macOS development machine cannot host the systemd/podman single-VM
deployment plan 1 sets up, and no such VM or cluster was reachable from the session that wrote
this file. Nothing below this line is a fabricated result: the tables are empty because no run
has happened, not because a run's numbers were omitted.

When a run is recorded, each driver appends its own dated section below this line — `e8-density.sh`
writes a "### E8 run \<timestamp\>" block with a per-rung JSON records array, and `e9-tiers.sh`
writes a "### E9 run \<timestamp\>" block with a VM-vs-Knative floor comparison table — following
exactly the templates already implemented in those two scripts. The empty tables below show the
shape a first run will fill in; they are not a substitute for one.

### E8 — concurrent in-flight turns sustained (floor)

| Run (UTC)         | W (workers) | S (turns/worker) | duty_basis | knee floor | saturated | bound |
| ----------------- | ----------- | ---------------- | ---------- | ---------- | --------- | ----- |
| _(none recorded)_ |             |                  |            |            |           |       |

### E9 — VM-with-supervisor vs Knative-per-session (floors)

| Run (UTC)         | Arm | Sustained in-flight turns (floor) |
| ----------------- | --- | --------------------------------- |
| _(none recorded)_ | —   | —                                 |

### V — real-model live-gate validation (§5.5, informational — not a density result)

`v-live-gate.sh` never appends to this file (by design — see its own header). This section exists
only so a reader looking for "did the VM path ever get validated against a real model" finds an
answer here rather than concluding silently that it was not: as of this writing, no `v-live-gate.sh`
run has been recorded either, for the same reason no E8/E9 run has — no VM was reachable from the
authoring session. A `V_GATE: PASS` line from a real run belongs in whoever's operational log ran
it, not in this results file, but its absence here should not be read as a signal about the VM
path's correctness one way or the other.
