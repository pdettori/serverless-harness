import type { Socket } from 'node:net';
import { pickLeastLoaded, type WorkerView } from './routing.js';

/**
 * Duplicated from `@sh/knative-server/src/worker.ts` deliberately (spec §9): the supervisor
 * forks the worker as a PROCESS, and a shared type module would advertise an in-process
 * coupling that does not exist. Task 9's integration test forks a real worker, so drift
 * fails a test rather than rotting.
 */
export type SupervisorToWorker = { type: 'conn'; head?: string } | { type: 'drain' };
export type WorkerToSupervisor =
  { type: 'ready'; pid: number } | { type: 'load'; inFlight: number } | { type: 'draining' };

/** The narrow slice of `ChildProcess` the pool uses, so tests can hand it a fake. */
export interface WorkerHandle {
  readonly pid?: number;
  send(msg: SupervisorToWorker, handle?: Socket): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'message', listener: (msg: WorkerToSupervisor) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface PoolOptions {
  readonly workers: number;
  readonly fork: (id: number) => WorkerHandle;
  readonly restartBackoffMs?: number;
  readonly healthyRunMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => void;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface PoolCounters {
  readonly restarts: number;
  readonly handoffRetries: number;
  readonly handoffFailures: number;
  readonly overAdmission: number;
  readonly spuriousRefusals: number;
}

const MAX_BACKOFF_MS = 30_000;

interface Slot {
  handle: WorkerHandle;
  /** Supervisor ESTIMATE (§3.9), not ground truth. */
  inFlight: number;
  healthy: boolean;
  startedAt: number;
  crashes: number;
  drained: boolean;
  /** Estimate for this slot at the moment of the pending refusal, if any. */
  refusalEstimate?: number;
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly opts: Required<
    Pick<PoolOptions, 'restartBackoffMs' | 'healthyRunMs' | 'now' | 'setTimer' | 'log'>
  > &
    PoolOptions;
  private shuttingDown = false;
  private refusalSeq = 0;
  private refusalCounted = true;
  private tally = {
    restarts: 0,
    handoffRetries: 0,
    handoffFailures: 0,
    overAdmission: 0,
    spuriousRefusals: 0,
  };

  constructor(opts: PoolOptions) {
    this.opts = {
      restartBackoffMs: 250,
      healthyRunMs: 10_000,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        setTimeout(fn, ms).unref?.();
      },
      log: (line) => {
        console.log(JSON.stringify(line));
      },
      ...opts,
    };
    for (let id = 0; id < opts.workers; id += 1) this.spawn(id);
  }

  get size(): number {
    return this.slots.length;
  }

  get counters(): PoolCounters {
    return { ...this.tally };
  }

  views(): readonly WorkerView[] {
    return this.slots.map((s, id) => ({ id, inFlight: s.inFlight, healthy: s.healthy }));
  }

  handOff(preferred: number, socket: Socket, head?: Buffer): number | undefined {
    const tried = new Set<number>();
    let target: number | undefined = preferred;
    while (target !== undefined) {
      tried.add(target);
      const slot = this.slots[target];
      const msg: SupervisorToWorker =
        head && head.length > 0
          ? { type: 'conn', head: head.toString('base64') }
          : { type: 'conn' };
      if (slot !== undefined && slot.healthy && slot.handle.send(msg, socket)) {
        // Optimistic: the worker's own `load` will correct this within one round trip (§3.9).
        slot.inFlight += 1;
        return target;
      }
      this.tally.handoffRetries += 1;
      this.opts.log({ event: 'handoff_retry', from: target });
      // §6: a worker can die between selection and hand-off. Retry the next-least-loaded
      // rather than fail the connection on a race the design accepts.
      target = pickLeastLoaded(this.views().filter((v) => !tried.has(v.id)));
    }
    // Never just drop it: a forgotten socket is a leaked fd, and on a saturation ladder that
    // is the leak that ends the run.
    this.tally.handoffFailures += 1;
    this.opts.log({ event: 'handoff_failed', preferred });
    socket.destroy();
    return undefined;
  }

  /**
   * Record that a 429 was issued with the current estimates. The next `load` from any worker
   * decides whether the pool could actually have served it (§3.9, §5.2).
   */
  noteRefusal(): void {
    this.refusalSeq += 1;
    this.refusalCounted = false;
    for (const slot of this.slots) slot.refusalEstimate = slot.inFlight;
  }

  drainAll(): void {
    this.shuttingDown = true;
    for (const slot of this.slots) {
      if (slot.drained) continue;
      slot.drained = true;
      slot.handle.send({ type: 'drain' });
    }
  }

  private spawn(id: number): void {
    const previous = this.slots[id];
    const handle = this.opts.fork(id);
    const slot: Slot = {
      handle,
      inFlight: 0,
      // Unhealthy until `ready`: before that the worker has not constructed its handler
      // server, so a socket handed to it would arrive with no parser attached.
      healthy: false,
      startedAt: this.opts.now(),
      crashes: previous?.crashes ?? 0,
      drained: false,
    };
    this.slots[id] = slot;

    handle.on('message', (msg) => {
      if (msg.type === 'ready') {
        slot.healthy = true;
        this.opts.log({ event: 'worker_ready', id, pid: msg.pid });
        return;
      }
      if (msg.type === 'draining') {
        // Stop routing, do not kill: in-flight turns run to completion.
        slot.healthy = false;
        return;
      }
      this.reconcile(id, slot, msg.inFlight);
    });

    handle.on('exit', (code, signal) => {
      slot.healthy = false;
      if (this.shuttingDown) return; // the whole set is going away
      const ranFor = this.opts.now() - slot.startedAt;
      if (ranFor >= this.opts.healthyRunMs) slot.crashes = 0;
      const delay = Math.min(this.opts.restartBackoffMs * 2 ** slot.crashes, MAX_BACKOFF_MS);
      slot.crashes += 1;
      this.tally.restarts += 1;
      this.opts.log({
        event: 'worker_exit',
        id,
        code,
        signal,
        ranForMs: ranFor,
        restartInMs: delay,
      });
      // In-flight turns die here; the sessions survive in Redis. That is E4's existing
      // pod-eviction semantics, not a new contract (§6).
      this.opts.setTimer(() => {
        if (!this.shuttingDown) this.spawn(id);
      }, delay);
    });
  }

  private reconcile(id: number, slot: Slot, actual: number): void {
    const estimate = slot.inFlight;
    slot.inFlight = actual; // the worker is the authority (§3.9)

    if (actual > estimate) {
      this.tally.overAdmission += 1;
      this.opts.log({ event: 'over_admission', id, estimate, actual });
    }

    const atRefusal = slot.refusalEstimate;
    if (atRefusal === undefined) return;
    slot.refusalEstimate = undefined;
    if (actual < atRefusal && !this.refusalCounted) {
      // The estimate was stale HIGH when we refused: the pool had capacity it did not offer.
      // Counted once per refusal, so W workers reporting lower is one event, not W.
      this.refusalCounted = true;
      this.tally.spuriousRefusals += 1;
      this.opts.log({
        event: 'refusal_reconciled',
        seq: this.refusalSeq,
        id,
        estimate: atRefusal,
        actual,
      });
    }
  }
}
