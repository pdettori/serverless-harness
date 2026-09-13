export interface LadderPoint {
  c: number; // concurrent leaves at this rung
  throughput: number; // aggregate leaves/sec
  p95Ms: number; // per-leaf p95 latency at this rung
}

/**
 * The knee = the highest concurrency still "healthy": p95 within `degradeX` of the single-leaf
 * baseline AND throughput at/above the running max. Tolerates transient dips — breaks only after
 * `patience` consecutive unhealthy rungs (per-leaf latency variance makes a single rung dip). The
 * knee that c is the recommended KAGENTI_SANDBOX_CAP (a floor when no break occurs).
 *
 * Load-bearing coupling, written down rather than fixed (round 2, "one thing to write down"):
 * `cur.p95Ms <= bound` below can receive JSON `null` for `p95Ms` on a rung whose latency file was
 * empty (deploy/vm/lib-vm.sh's `percentile` returns "NaN" over no input; deploy/vm/e8-density.sh
 * passes that to jq via --argjson, which serializes an accepted-but-unrepresentable NaN back out
 * as `null`). In JS, `null <= bound` coerces `null` to `0`, so this comparison evaluates true —
 * an all-failed rung's latency half reads as PERFECT, not missing. The only thing stopping that
 * from making the rung "healthy" outright is the OTHER half of the `&&` below: `cur.throughput`
 * is genuinely 0 for an all-failed rung, which fails `>= best` as long as `best` is positive —
 * and the only thing guaranteeing `best` starts positive (from `baseline.throughput`) is
 * lib-vm.sh's `require_live_arm`, which hard-fails before any rung runs if c=1 saw zero 200s.
 * Three mechanisms in three different places, none aware of the others, currently balance to a
 * safe result. See `percentile`'s own comment (lib-vm.sh) for the other half of this.
 */
export function detectKnee(points: LadderPoint[], degradeX: number, patience = 2): number {
  const baseline = points.find((p) => p.c === 1);
  if (!baseline) throw new Error('detectKnee: no c=1 baseline point');
  const bound = baseline.p95Ms * degradeX;
  const sorted = [...points].sort((a, b) => a.c - b.c);
  let knee = 1;
  let best = baseline.throughput;
  let unhealthy = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const healthy = cur.p95Ms <= bound && cur.throughput >= best;
    if (healthy) {
      knee = cur.c;
      best = cur.throughput;
      unhealthy = 0;
    } else if (++unhealthy >= patience) {
      break;
    }
  }
  return knee;
}

/** Fraction of wall-clock the sandbox was busy on this leaf's execs; in (0, 1]. */
export function dutyCycle(execBusyMs: number, wallMs: number): number {
  if (wallMs <= 0) throw new Error('dutyCycle: wallMs must be > 0');
  return Math.min(1, execBusyMs / wallMs);
}

/** How many such leaves time-share one sandbox before it is continuously busy. */
export function derivedRatio(duty: number): number {
  if (duty <= 0) throw new Error('derivedRatio: duty must be > 0');
  return Math.round((1 / duty) * 10) / 10;
}

/** CI floor: one sandbox must sustain at least `minConcurrency` healthy leaves. */
export function sanityFloorPass(knee: number, minConcurrency: number): boolean {
  return knee >= minConcurrency;
}

export interface LeafObservation {
  runId: string;
  expectedRef: string; // the ref this leaf's envelope pinned
  observedMarker: string; // marker.txt content read from its worktree
}

/** Every leaf must have seen its own ref's marker — no sibling leakage. */
export function worktreeConsistent(obs: LeafObservation[]): {
  ok: boolean;
  mismatches: LeafObservation[];
} {
  const mismatches = obs.filter((o) => o.observedMarker !== o.expectedRef);
  return { ok: mismatches.length === 0, mismatches };
}

export interface WorkloadPoint {
  label: string;
  execMs: number; // sandbox-busy ms attributable to one leaf of this workload
  execCount: number; // number of sandbox execs the leaf issued
  wallMs: number; // leaf wall-clock
}

export interface RatioCurvePoint {
  label: string;
  execCount: number;
  duty: number;
  n: number;
}

/** N ≈ 1/duty at each workload intensity — the sharing ratio as a curve over sandbox work. */
export function buildRatioCurve(points: WorkloadPoint[]): RatioCurvePoint[] {
  return points.map((p) => {
    const duty = dutyCycle(p.execMs, p.wallMs);
    return { label: p.label, execCount: p.execCount, duty, n: derivedRatio(duty) };
  });
}

export interface ArmResult {
  arm: 'dedicated' | 'shared';
  resvSecPerLeaf: number;
  p95Ms: number;
  throughput: number;
  peakPods: number;
}

/** Benefit = dedicated:shared reservation-seconds/leaf; withinDegrade gates on p95 (spec §7). */
export function reservationBenefit(
  dedicated: ArmResult,
  shared: ArmResult,
  degradeX: number,
): { ratio: number; withinDegrade: boolean } {
  if (shared.resvSecPerLeaf <= 0)
    throw new Error('reservationBenefit: shared resvSecPerLeaf must be > 0');
  const ratio = Math.round((dedicated.resvSecPerLeaf / shared.resvSecPerLeaf) * 10) / 10;
  return { ratio, withinDegrade: shared.p95Ms <= dedicated.p95Ms * degradeX };
}
