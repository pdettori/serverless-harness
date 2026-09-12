/**
 * Duty-cycle bases from P6 spec §2.3.
 *
 * The rule the spec states and this module enforces: **a basis is a row, taken whole.** Duty
 * and the implied sessions-per-sandbox ratio are reciprocals of each other, so mixing one row's
 * duty with another's ratio describes a workload nobody measured. The consequence is not
 * academic: the ratio sets the sandbox pool size, and an under-provisioned pool makes turns
 * wait on leases — which looks, on an E8 rung, exactly like the worker tier saturating. The
 * knee gets attributed to the wrong bound and reads early.
 */

import { derivedRatio } from './sharing';

/** One row of spec §2.3's table, taken whole. */
export interface DutyBasis {
  readonly name: 'e6-ocp' | 'e6-kind' | 'e7';
  readonly label: string;
  readonly duty: readonly [number, number];
  readonly ratio: readonly [number, number];
  readonly cite: string;
}

export const DUTY_BASES: readonly DutyBasis[] = [
  {
    name: 'e6-ocp',
    label: 'E6 / OCP — real Archetype-A code review (L0/L1/L2) on OpenShift',
    duty: [0.061, 0.079],
    ratio: [12.6, 16.5],
    cite: 'deploy/knative/EXPERIMENTS.md:88-94',
  },
  {
    name: 'e6-kind',
    label: 'E6 / kind — same workload, kind cluster',
    duty: [0.042, 0.051],
    ratio: [19.7, 24.0],
    cite: 'deploy/knative/EXPERIMENTS.md:76-80',
  },
  {
    name: 'e7',
    label: 'E7 — E7_REFS mixed-ref converge',
    duty: [0.021, 0.035],
    ratio: [28.6, 47.6],
    cite: 'deploy/knative/EXPERIMENTS.md:121,161',
  },
] as const;

/**
 * P6 provisions from the OCP row: real hardware, the real Archetype-A workload, and the
 * highest duty of the three — so a pool sized from it is not short when the workload is
 * heavier than E7's converge loop (§2.3).
 */
export const DEFAULT_BASIS: DutyBasis = DUTY_BASES[0]!;

export function resolveBasis(name: string | undefined): DutyBasis {
  const raw = name?.trim();
  if (!raw) return DEFAULT_BASIS;
  const found = DUTY_BASES.find((b) => b.name === raw);
  if (!found) {
    // Listing the rows matters more than usual here: 'e6' is the natural typo and it is
    // genuinely ambiguous between two rows whose duty bands differ by ~1.5x.
    throw new Error(`duty basis '${raw}' is not one of ${DUTY_BASES.map((b) => b.name).join('|')}`);
  }
  return found;
}

/** `K >= ceil(W * S * duty)` — the sandbox floor for a W x S provisioning point. */
export function sandboxFloor(workers: number, turnsPerWorker: number, duty: number): number {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`sandboxFloor: workers must be a positive integer, got ${workers}`);
  }
  if (!Number.isInteger(turnsPerWorker) || turnsPerWorker < 1) {
    throw new Error(
      `sandboxFloor: turnsPerWorker must be a positive integer, got ${turnsPerWorker}`,
    );
  }
  if (!(duty > 0) || duty > 1) {
    throw new Error(`sandboxFloor: duty must be in (0, 1], got ${duty}`);
  }
  // Never 0: a single low-duty session rounds to 0.08, and a pool of zero sandboxes fails
  // every tool call on lease acquisition rather than measuring anything.
  return Math.max(1, Math.ceil(workers * turnsPerWorker * duty));
}

/** Throws unless `duty` and `ratio` are reciprocals — i.e. unless they came from one row. */
export function assertBasisConsistent(duty: number, ratio: number, tolerance = 0.15): void {
  if (!(duty > 0)) throw new Error(`assertBasisConsistent: duty must be > 0, got ${duty}`);
  if (!(ratio > 0)) throw new Error(`assertBasisConsistent: ratio must be > 0, got ${ratio}`);
  const implied = derivedRatio(duty);
  const unroundedImplied = 1 / duty;
  const relative = Math.abs(ratio - unroundedImplied) / unroundedImplied;
  if (relative > tolerance) {
    throw new Error(
      `duty ${duty} implies a ratio of ${implied}, not ${ratio} ` +
        `(off by ${Math.round(relative * 100)}%) — this is a blend of two §2.3 rows. ` +
        `Take one row whole: ${DUTY_BASES.map((b) => `${b.name} duty ${b.duty[0]}-${b.duty[1]} ratio ${b.ratio[0]}-${b.ratio[1]}`).join('; ')}`,
    );
  }
}

/** One line naming the basis, for a run record. */
export function describeBasis(b: DutyBasis): string {
  return (
    `${b.name} (${b.label}): duty ${b.duty[0]}-${b.duty[1]}, ` +
    `implied ${b.ratio[0]}-${b.ratio[1]} sessions/sandbox [${b.cite}]`
  );
}
