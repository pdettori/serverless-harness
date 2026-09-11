/** What the supervisor believes about one worker at decision time. */
export interface WorkerView {
  readonly id: number;
  /**
   * The supervisor's ESTIMATE, not ground truth: incremented optimistically on hand-off and
   * reconciled whenever the worker sends `load` (§3.9). Lag is bounded by one IPC round trip.
   */
  readonly inFlight: number;
  readonly healthy: boolean;
}

/** All a policy is allowed to know about the connection it is routing. */
export interface ConnectionFacts {
  readonly sessionId?: string;
}

export interface RoutingPolicy {
  readonly name: 'leastInFlight' | 'stickyBySession';
  /** True ⇒ the supervisor must pre-read the request head before it can call `pick`. */
  readonly needsHead: boolean;
  /**
   * Called exactly ONCE per connection, before hand-off. There is deliberately no
   * per-request entry point: a keep-alive socket belongs to the worker that received it, and
   * a second session id arriving on it is neither seen nor re-routable (§3.4, §7).
   */
  pick(workers: readonly WorkerView[], facts: ConnectionFacts): number | undefined;
}

/** Fewest in-flight turns wins; ties go to the lowest id so E8 replays are deterministic. */
export function pickLeastLoaded(workers: readonly WorkerView[]): number | undefined {
  let best: WorkerView | undefined;
  for (const wv of workers) {
    // A restarting worker has inFlight 0, which would make it the most attractive target
    // exactly when it cannot serve. Health gates the comparison; it is not a tiebreak.
    if (!wv.healthy) continue;
    if (best === undefined || wv.inFlight < best.inFlight) best = wv;
  }
  return best?.id;
}

/**
 * Default. Deliberately mirrors `orderByLoad` one tier up (`harness/src/select-sandbox.ts:16`)
 * so the two tiers are not separately-tuned mysteries when E9 compares them.
 */
export const leastInFlight: RoutingPolicy = {
  name: 'leastInFlight',
  // No head ⇒ the supervisor never reads a request byte on the default path (§3.2).
  needsHead: false,
  pick: (workers) => pickLeastLoaded(workers),
};

/**
 * Sweep variant (§3.4): pin a session to a worker so its in-process state is reused. Costs a
 * pre-read of the header block, which is why it is not the default.
 *
 * Each call returns a policy with its OWN affinity table: sharing one would leak pins across
 * E8/E9 arms and quietly change what a rung measures.
 */
export function stickyBySession(): RoutingPolicy {
  const pins = new Map<string, number>();
  return {
    name: 'stickyBySession',
    needsHead: true,
    pick(workers, facts) {
      const sid = facts.sessionId;
      if (sid === undefined) return pickLeastLoaded(workers);
      const pinned = pins.get(sid);
      if (pinned !== undefined && workers.some((wv) => wv.id === pinned && wv.healthy)) {
        return pinned;
      }
      const chosen = pickLeastLoaded(workers);
      // Re-pin rather than retry the dead worker; otherwise a crash strands every session
      // that was affine to it (§6).
      if (chosen !== undefined) pins.set(sid, chosen);
      return chosen;
    },
  };
}

export function policyFromName(name: string | undefined): RoutingPolicy {
  const raw = name?.trim();
  if (!raw || raw === 'leastInFlight') return leastInFlight;
  if (raw === 'stickyBySession') return stickyBySession();
  throw new Error(`SH_ROUTING_POLICY='${raw}' is not one of leastInFlight|stickyBySession`);
}
