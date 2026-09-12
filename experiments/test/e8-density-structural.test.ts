import { describe, it, expect } from 'vitest';
import { detectKnee, sanityFloorPass, type LadderPoint } from '../src/sharing';
import { DEFAULT_BASIS, sandboxFloor, assertBasisConsistent } from '../src/basis';

/** What a healthy E8 ladder looks like: p95 grows, then blows past 2x baseline. */
const HEALTHY: LadderPoint[] = [
  { c: 1, throughput: 1.0, p95Ms: 900 }, // baseline — detectKnee THROWS without this rung
  { c: 2, throughput: 1.9, p95Ms: 980 },
  { c: 4, throughput: 3.6, p95Ms: 1150 },
  { c: 8, throughput: 6.8, p95Ms: 1600 }, // still <= 1800 (2x)
  { c: 16, throughput: 7.1, p95Ms: 3400 }, // degraded: p95 past bound
];

describe('E8 ladder analysis', () => {
  it('reports the last healthy rung as the knee floor', () => {
    expect(detectKnee(HEALTHY, 2, 2)).toBe(8);
  });

  it('passes the sanity floor at the density P6 is worth reporting', () => {
    // Below this there is no density story worth a VM: a single 4-vCPU box that cannot hold
    // 4 concurrent turns is not competitive with per-session pods on any axis.
    expect(sanityFloorPass(detectKnee(HEALTHY, 2, 2), 4)).toBe(true);
  });

  it('throws — loudly — on a ladder with no c=1 rung', () => {
    // The driver MUST include c=1. Discovering this in a stack trace after an hour of
    // measurement wastes the whole run, so the driver asserts it up front (Step 3.3).
    expect(() => detectKnee(HEALTHY.slice(1), 2, 2)).toThrow(/no c=1 baseline/);
  });

  it('a ladder whose top rung is still healthy reports a floor, not a ceiling', () => {
    const notSaturated: LadderPoint[] = [
      { c: 1, throughput: 1.0, p95Ms: 900 },
      { c: 2, throughput: 2.0, p95Ms: 950 },
      { c: 4, throughput: 3.9, p95Ms: 1000 },
    ];
    // 4 is the top of the ladder, not the machine's limit. Every record says "floor".
    expect(detectKnee(notSaturated, 2, 2)).toBe(4);
  });
});

describe('E8 provisioning arithmetic', () => {
  it('derives the sandbox floor for the W x S point from ONE basis row', () => {
    // 4 workers x 8 turns at OCP's high duty.
    expect(sandboxFloor(4, 8, DEFAULT_BASIS.duty[1])).toBe(3);
  });

  it('refuses the blend the driver could be mis-parameterised into', () => {
    expect(() => assertBasisConsistent(DEFAULT_BASIS.duty[0], 24)).toThrow(/blend/i);
  });
});
