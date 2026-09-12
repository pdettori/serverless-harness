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

## What every run record must carry (§5.2, §5.7)

A record missing any of these is not a result:

| Field               | Why it is load-bearing                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| `duty_basis`        | One §2.3 row, taken whole. A blend implies a wrong sandbox count.             |
| `conns_per_session` | Sticky routing decides once per connection; must match across arms.           |
| stub profile        | Half the claim. ttft, token delay, output tokens, tool-call rate.             |
| `loop_lag_p99`      | Attributes a knee to worker CPU / socket multiplexing.                        |
| `rss_bytes`         | Memory per live session.                                                      |
| `file_op_ms`        | The relay round trip.                                                         |
| `sandbox_cpu`       | `bash -c` churn across the pool.                                              |
| `lease_saturation`  | An under-provisioned pool, which reads exactly like worker saturation.        |
| `over_admission`    | Bounds IPC staleness; self-correcting, so it is a diagnostic not a failure.   |
| `spurious_refusals` | Refusals the next `load` convicted. Attributes a `spurious_429` to staleness. |
| `spurious_429`      | **The dangerous one.** Refusals truncate a rung, so the knee reads early.     |

### Two of these columns are permanently `NaN` — this is not a missing run, it is a missing sensor

Of the eleven fields above, **six** are real, load-bearing telemetry every run record actually
carries: `loop_lag_p99`, `rss_bytes`, `sandbox_cpu`, `over_admission`, `spurious_refusals`,
`spurious_429`. The other two, `lease_saturation` and `file_op_ms`, will read `NaN` in **every**
record `e8-density.sh` or `e9-tiers.sh` ever appends here, on any VM, no matter how it is
provisioned — not because the run failed to collect them, but because nothing in this repository
computes them. `harness/src/sandbox-lease.ts` derives a lease _count_ from an array its caller
already holds; it keeps no pool-wide state a supervisor could expose as a saturation ratio.
No file-op p95 counter exists anywhere in `harness/src` or `packages/k8s-sandbox/src` either. A
future change could add both — this file does not claim the gap is permanent architecture, only
that it is real today — but until one does, `lease_saturation` and `file_op_ms` are not
measurements this driver declined to make; they are measurements this codebase cannot yet make.

**Read every bound sentence in this file accordingly.** When a run record says "the bound
observed at: worker CPU / memory / admission-control / unattributed", that verdict is reached by
checking only the six real columns — it is never checked against `lease_saturation` or
`file_op_ms`, because there is nothing there to check. So "unattributed" does **not** mean "no
tier is responsible"; it means "of the six tiers we can see, none crossed its threshold." An
under-provisioned sandbox-pool tier or a slow relay round trip could be the actual cause of a
knee in this file and would show up as `unattributed` here, indistinguishable from a genuinely
even, non-bottlenecked run. Do not read `unattributed` as an exoneration of the lease/relay
tiers — read it as `unattributed (lease-pool and relay tiers unmeasured)`. Every claim sentence
a driver emits should be read with that qualifier whether or not the driver's own prose spells
it out at the point the sentence is written.

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
