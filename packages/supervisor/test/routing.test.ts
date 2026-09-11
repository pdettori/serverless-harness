import { describe, it, expect } from 'vitest';
import {
  pickLeastLoaded,
  leastInFlight,
  stickyBySession,
  policyFromName,
  type WorkerView,
} from '../src/routing.js';

const w = (id: number, inFlight: number, healthy = true): WorkerView => ({ id, inFlight, healthy });

describe('pickLeastLoaded', () => {
  it('picks the least loaded worker', () => {
    expect(pickLeastLoaded([w(0, 3), w(1, 1), w(2, 2)])).toBe(1);
  });

  it('breaks ties toward the lowest id, so routing is deterministic in E8 replays', () => {
    expect(pickLeastLoaded([w(0, 2), w(1, 2), w(2, 2)])).toBe(0);
  });

  it('skips unhealthy workers', () => {
    // A worker restarting after a crash has inFlight 0, which makes it the most attractive
    // target precisely when it cannot serve. Health gates the comparison.
    expect(pickLeastLoaded([w(0, 5), w(1, 0, false)])).toBe(0);
  });

  it('returns undefined when nothing is usable', () => {
    expect(pickLeastLoaded([])).toBeUndefined();
    expect(pickLeastLoaded([w(0, 0, false)])).toBeUndefined();
  });
});

describe('leastInFlight', () => {
  it('needs no head, so the default path never touches request bytes', () => {
    // This is the property that keeps the default a pure fd hand-off (§3.2).
    expect(leastInFlight.needsHead).toBe(false);
    expect(leastInFlight.name).toBe('leastInFlight');
  });

  it('ignores a session id even when one is offered', () => {
    expect(leastInFlight.pick([w(0, 4), w(1, 0)], { sessionId: 'sess-1' })).toBe(1);
  });
});

describe('stickyBySession', () => {
  it('needs the head — that is the cost of affinity', () => {
    const p = stickyBySession();
    expect(p.needsHead).toBe(true);
    expect(p.name).toBe('stickyBySession');
  });

  it('pins a session to one worker across connections', () => {
    const p = stickyBySession();
    const first = p.pick([w(0, 0), w(1, 0)], { sessionId: 'sess-1' })!;
    // Now make the pinned worker the worst choice. Affinity must still win.
    const loads = [w(0, 0), w(1, 0)].map((v) => (v.id === first ? w(v.id, 9) : v));
    expect(p.pick(loads, { sessionId: 'sess-1' })).toBe(first);
  });

  it('load-balances a connection whose first request carries no session id', () => {
    // §3.4: affinity is keyed by the FIRST request. No id ⇒ nothing to be sticky about.
    const p = stickyBySession();
    expect(p.pick([w(0, 3), w(1, 1)], {})).toBe(1);
  });

  it('re-pins when the affine worker dies, instead of returning a dead worker', () => {
    const p = stickyBySession();
    const first = p.pick([w(0, 0), w(1, 0)], { sessionId: 'sess-1' })!;
    const other = first === 0 ? 1 : 0;
    expect(p.pick([w(first, 0, false), w(other, 5)], { sessionId: 'sess-1' })).toBe(other);
    // …and the new pin sticks, so the session does not oscillate (§6).
    expect(p.pick([w(first, 0), w(other, 9)], { sessionId: 'sess-1' })).toBe(other);
  });

  it('has no per-request hook: a policy decides once per connection', () => {
    // §3.4 / §7. A second session id on an already-routed keep-alive socket is neither seen
    // nor re-routable, and the SHAPE of this interface is what makes that true — there is no
    // method to call again mid-connection. The end-to-end pin is Task 9's integration test.
    const p = stickyBySession();
    expect(Object.keys(p).sort()).toEqual(['name', 'needsHead', 'pick']);
  });
});

describe('policyFromName', () => {
  it('defaults to leastInFlight on unset or blank', () => {
    expect(policyFromName(undefined).name).toBe('leastInFlight');
    expect(policyFromName('  ').name).toBe('leastInFlight');
  });

  it('accepts both names and trims', () => {
    expect(policyFromName(' stickyBySession ').name).toBe('stickyBySession');
    expect(policyFromName('leastInFlight').name).toBe('leastInFlight');
  });

  it('returns a FRESH sticky policy each call so affinity never leaks between runs', () => {
    const a = policyFromName('stickyBySession');
    const b = policyFromName('stickyBySession');
    const pinnedInA = a.pick([w(0, 0), w(1, 0)], { sessionId: 'sess-1' })!;
    // b has never seen sess-1, so it must load-balance rather than inherit a's table.
    const loads = [w(0, 0), w(1, 0)].map((v) => (v.id === pinnedInA ? w(v.id, 9) : v));
    expect(b.pick(loads, { sessionId: 'sess-1' })).not.toBe(pinnedInA);
  });

  it('rejects an unknown policy naming the variable and the legal set', () => {
    expect(() => policyFromName('roundRobin')).toThrow(
      /SH_ROUTING_POLICY='roundRobin' is not one of leastInFlight\|stickyBySession/,
    );
  });
});
