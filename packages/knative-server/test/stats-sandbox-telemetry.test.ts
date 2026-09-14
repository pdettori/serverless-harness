import { describe, expect, it, vi } from 'vitest';
import { startStatsReporter, type WorkerToSupervisor } from '../src/worker.js';

// `leasesHeld` / `leasePoolSize` have been declared on the stats message and consumed by
// packages/supervisor/src/pool.ts (which derives lease_saturation from them) since Task 11 — but
// NOTHING EVER SENT THEM. That is the entire reason lease_saturation reads 'NaN' in every E8 run
// record to date and the driver reports `bound=unattributed`. These tests pin the producer.
//
// The numbers are read from the harness's sandbox telemetry, which the selection path updates as a
// by-product of work it already does, so this tick performs no Redis query of its own — deliberate,
// because the tick runs inside the process E8 is measuring.

function collect(sandbox: { leasePoolSize: number; leasesHeld: number }): WorkerToSupervisor[] {
  const sent: WorkerToSupervisor[] = [];
  vi.useFakeTimers();
  try {
    const stop = startStatsReporter({
      send: (m) => sent.push(m),
      intervalMs: 10,
      lag: () => 1,
      rss: () => 2,
      sandbox: () => sandbox,
    });
    vi.advanceTimersByTime(10);
    stop();
  } finally {
    vi.useRealTimers();
  }
  return sent;
}

describe('startStatsReporter sandbox telemetry', () => {
  it('sends the leases held and the pool size the selection path observed', () => {
    const [msg] = collect({ leasePoolSize: 3, leasesHeld: 2 });

    expect(msg).toMatchObject({ type: 'stats', leasesHeld: 2, leasePoolSize: 3 });
  });

  it('omits the pool size entirely while it is unobserved, rather than sending NaN', () => {
    const [msg] = collect({ leasePoolSize: Number.NaN, leasesHeld: 0 });

    // JSON has no NaN, so over the IPC channel it would arrive as `null` — and pool.ts's
    // `msg.leasePoolSize !== undefined` guard would then store null as though a worker had
    // reported a real sample, which reads downstream as an observed-empty pool. Omitting the key
    // keeps "never observed" distinguishable from "observed empty", the distinction E8's
    // precondition turns on.
    expect(msg).toMatchObject({ type: 'stats', leasesHeld: 0 });
    expect(msg && 'leasePoolSize' in msg).toBe(false);
  });

  it('still reports zero held leases as a real 0', () => {
    // 0 held is a fact; only the POOL SIZE has an unobserved state.
    const [msg] = collect({ leasePoolSize: 4, leasesHeld: 0 });

    expect(msg).toMatchObject({ leasesHeld: 0, leasePoolSize: 4 });
  });
});
