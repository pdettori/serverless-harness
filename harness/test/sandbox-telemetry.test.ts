import { beforeEach, describe, expect, it } from 'vitest';
import {
  noteLeaseAcquired,
  noteLeaseReleased,
  recordPoolObservation,
  resetSandboxTelemetry,
  sandboxTelemetry,
} from '../src/sandbox-telemetry.js';

describe('sandbox telemetry', () => {
  beforeEach(() => resetSandboxTelemetry());

  it('starts with an UNOBSERVED pool size, not zero', () => {
    // The load-bearing property. A 0 at boot is indistinguishable from a genuinely empty pool, and
    // the two demand opposite responses from E8's precondition: refuse-to-measure for unobserved
    // (after a live rung it means no turn went through pool selection), fail-the-floor for empty.
    expect(sandboxTelemetry().leasePoolSize).toBeNaN();
    expect(sandboxTelemetry().leasesHeld).toBe(0);
  });

  it('records an observed EMPTY pool as 0, distinct from unobserved', () => {
    recordPoolObservation(0);
    expect(sandboxTelemetry().leasePoolSize).toBe(0);
  });

  it('keeps the most recent observation', () => {
    recordPoolObservation(3);
    recordPoolObservation(2);
    // Latest, not max: a sandbox that dropped out has genuinely left the pool, and reporting the
    // high-water mark would understate saturation for the rest of the process's life.
    expect(sandboxTelemetry().leasePoolSize).toBe(2);
  });

  it('counts leases up and down', () => {
    noteLeaseAcquired();
    noteLeaseAcquired();
    expect(sandboxTelemetry().leasesHeld).toBe(2);
    noteLeaseReleased();
    expect(sandboxTelemetry().leasesHeld).toBe(1);
  });

  it('clamps at zero so a double release cannot go negative', () => {
    // executeTurn decrements in a finally even when release() rejected, so a defensive clamp is
    // cheaper than a negative count that would render lease_saturation nonsense for the process's
    // remaining life.
    noteLeaseAcquired();
    noteLeaseReleased();
    noteLeaseReleased();
    expect(sandboxTelemetry().leasesHeld).toBe(0);
  });
});
