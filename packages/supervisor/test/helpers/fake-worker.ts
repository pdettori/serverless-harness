import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Socket } from 'node:net';
import {
  WorkerPool,
  type WorkerHandle,
  type SupervisorToWorker,
  type PoolOptions,
} from '../../src/pool.js';

let nextPid = 1000;

export class FakeWorker extends EventEmitter implements WorkerHandle {
  readonly pid = nextPid++;
  readonly sent: Array<{ msg: SupervisorToWorker; hasHandle: boolean }> = [];
  sendOk = true;
  killed: NodeJS.Signals | undefined;

  send(msg: SupervisorToWorker, handle?: Socket): boolean {
    // A dead child's send() returns false (and emits an error asynchronously) — the exact
    // shape of the hand-off race in §6.
    if (!this.sendOk) return false;
    this.sent.push({ msg, hasHandle: handle !== undefined });
    return true;
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
  ready(): void {
    this.emit('message', { type: 'ready', pid: this.pid });
  }
  load(inFlight: number): void {
    this.emit('message', { type: 'load', inFlight });
  }
  draining(): void {
    this.emit('message', { type: 'draining' });
  }
  stats(s: {
    loopLagP99Ms?: number;
    rssBytes?: number;
    leasesHeld?: number;
    leasePoolSize?: number;
    fileOpP95Ms?: number;
  }): void {
    this.emit('message', { type: 'stats', ...s });
  }
  exit(code: number | null = 1): void {
    this.emit('exit', code, null);
  }
  get conns(): number {
    return this.sent.filter((s) => s.msg.type === 'conn').length;
  }
}

export interface Harness {
  pool: WorkerPool;
  forked: FakeWorker[];
  timers: Array<{ fn: () => void; ms: number }>;
  logs: Array<Record<string, unknown>>;
  clock: { t: number };
  runTimers: () => void;
}

export function harness(overrides: Partial<PoolOptions> = {}, workers = 2): Harness {
  const forked: FakeWorker[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const clock = { t: 0 };
  const pool = new WorkerPool({
    workers,
    fork: () => {
      const w = new FakeWorker();
      forked.push(w);
      return w;
    },
    now: () => clock.t,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    log: (line) => logs.push(line),
    ...overrides,
  });
  const runTimers = (): void => {
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
  };
  return { pool, forked, timers, logs, clock, runTimers };
}

export const fakeSocket = (): Socket => ({ destroy: vi.fn(), pause: vi.fn() }) as unknown as Socket;
