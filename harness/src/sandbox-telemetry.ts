/**
 * Process-wide sandbox-pool observations, for a worker to report to its supervisor.
 *
 * Both numbers are BY-PRODUCTS of work the selection path already does, which is the point:
 * `selectPoolSandbox` lists the pool on every turn that leases, so the size costs no extra Redis
 * round trip. Adding a query on the telemetry tick instead would put self-inflicted load inside the
 * very process E8 measures — the same reasoning that removed the driver's per-turn subprocesses.
 *
 * Module-level mutable state, deliberately: this describes THIS process, exactly like the event-loop
 * histogram and RSS the worker reports beside it. There is one worker per process.
 *
 * `leasePoolSize` starts as NaN rather than 0 and stays NaN until a selection has actually happened.
 * A 0 here would be indistinguishable from "the pool is empty", which is the single most expensive
 * confusion available: a precondition gate reading 0 for "not yet observed" fails a healthy run, and
 * one reading 0 as "observed empty" passes a run whose sandbox tier is missing. The supervisor's
 * aggregate already treats non-finite as absent (`Number.isFinite` filters in pool.ts).
 */
let leasePoolSize = Number.NaN;
let leasesHeld = 0;

/**
 * Record the pool as the selection path just saw it — `candidates.length`, i.e. what a lease could
 * actually be taken against. NOT a container count: a sandbox container that is running but never
 * attached to the relay has no presence record, so it is not leasable, and counting it is how a
 * pool looks present while being empty (observed on hardware: three running containers, zero
 * records).
 */
export function recordPoolObservation(size: number): void {
  leasePoolSize = size;
}

/** One lease taken by this process. Pairs with `noteLeaseReleased`. */
export function noteLeaseAcquired(): void {
  leasesHeld += 1;
}

/** One lease returned by this process. Clamped at 0 so a double release cannot make it negative. */
export function noteLeaseReleased(): void {
  leasesHeld = Math.max(0, leasesHeld - 1);
}

/** The two fields the worker's `stats` message carries. */
export function sandboxTelemetry(): { leasePoolSize: number; leasesHeld: number } {
  return { leasePoolSize, leasesHeld };
}

/** Test-only: restore the module to its boot state. */
export function resetSandboxTelemetry(): void {
  leasePoolSize = Number.NaN;
  leasesHeld = 0;
}
