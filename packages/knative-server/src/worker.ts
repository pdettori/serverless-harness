import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { handler } from './server.js';

/** Worker → supervisor. Exactly the three rows in P6 §3.9. */
export type WorkerToSupervisor =
  { type: 'ready'; pid: number } | { type: 'load'; inFlight: number } | { type: 'draining' };

/**
 * Supervisor → worker. A `conn` rides in `child.send(msg, socket)`'s handle slot; `head`
 * is base64 of the bytes the supervisor pre-read to route (sticky mode only, §3.4).
 */
export type SupervisorToWorker = { type: 'conn'; head?: string } | { type: 'drain' };

/** The two turn routes `server.ts:641` matches, by exact URL equality as it does. */
const TURN_PATHS = new Set(['/turn', '/v1/turn']);

/**
 * Does this request consume a turn slot? Mirrors `server.ts:641` exactly — including that
 * it compares the *raw* target, so `/turn?sid=x` is not a turn there and must not be one
 * here either. Divergence would make the worker's in-flight count describe a different set
 * of requests than the ones it actually runs.
 */
export function isTurnRequest(method: string | undefined, url: string | undefined): boolean {
  return method === 'POST' && TURN_PATHS.has(url ?? '');
}

/**
 * In-flight turn count. The worker is the authority (§3.9); the supervisor's copy is an
 * estimate it reconciles from `load`.
 */
export class TurnCounter {
  private n = 0;
  constructor(private readonly onChange: (inFlight: number) => void) {}

  get inFlight(): number {
    return this.n;
  }

  /** Marks a turn started; returns an **idempotent** end function. */
  start(): () => void {
    this.n += 1;
    this.onChange(this.n);
    let ended = false;
    return () => {
      // One-shot on purpose. A second decrement (an abort path that also calls end) would
      // bias the supervisor's estimate permanently low — silent over-admission forever.
      if (ended) return;
      ended = true;
      this.n -= 1;
      this.onChange(this.n);
    };
  }
}

export interface WorkerRuntime {
  readonly server: Server;
  readonly counter: TurnCounter;
  /** Serve one handed-off socket. `head` is any bytes the supervisor already consumed. */
  accept(socket: Socket, head?: Buffer): void;
  drain(): void;
}

export function createWorkerRuntime(opts: {
  send: (msg: WorkerToSupervisor) => void;
  requestHandler?: RequestListener;
}): WorkerRuntime {
  const { send } = opts;
  // Never listen(). This server exists only to own an HTTP parser and the request/response
  // plumbing for sockets that arrive over IPC. Binding a port would make the worker
  // independently reachable and put two admission controllers in the system.
  const server = createServer(opts.requestHandler ?? handler);
  const counter = new TurnCounter((inFlight) => send({ type: 'load', inFlight }));
  let draining = false;

  server.on('request', (req, res) => {
    if (!isTurnRequest(req.method, req.url)) return;
    const end = counter.start();
    // 'close' covers both a finished response and a client abort, which is what "the turn
    // is no longer occupying this process" actually means.
    res.on('close', end);
  });

  send({ type: 'ready', pid: process.pid });

  return {
    server,
    counter,
    accept(socket: Socket, head?: Buffer): void {
      // The socket arrived as a file descriptor, which carries no JS-side buffer: bytes the
      // supervisor read to make its routing decision are gone from the kernel buffer too.
      // They must be unshifted HERE, onto the stream this process is about to read.
      // Unshifting them in the supervisor would push them onto a stream nobody reads again
      // and silently truncate the request line — the request would hang or 400.
      if (head && head.length > 0) socket.unshift(head);
      server.emit('connection', socket);
    },
    drain(): void {
      if (draining) return;
      draining = true;
      send({ type: 'draining' });
      // Stop keep-alive reuse; in-flight turns run to completion on their own sockets.
      server.closeIdleConnections();
    },
  };
}

/** `--role=turn` / `--role turn`. Round one drives turns only (§3.3, §8). */
export function parseRole(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--role=')) return a.slice('--role='.length);
    if (a === '--role') return argv[i + 1] ?? '';
  }
  return 'turn';
}

const entry = process.argv[1];
const isMainModule = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMainModule) {
  const role = parseRole(process.argv.slice(2));
  if (role !== 'turn') {
    // The flag exists so leaf mode is a later experiment, not a later redesign (§3.3).
    console.error(`--role=${role} is not implemented in round one; only --role=turn is`);
    process.exit(2);
  }
  const channel = process.send;
  if (typeof channel !== 'function') {
    console.error('sh-worker must be forked by @sh/supervisor (no IPC channel available)');
    process.exit(2);
  }
  // process.send is overloaded three ways in @types/node; pin the signature we actually use
  // before .call() so tsc doesn't resolve .call to a differently-shaped overload.
  const sendToSupervisor = channel as (this: NodeJS.Process, msg: WorkerToSupervisor) => boolean;
  const runtime = createWorkerRuntime({
    send: (msg) => {
      sendToSupervisor.call(process, msg);
    },
  });
  process.on('message', (msg: SupervisorToWorker, handle) => {
    if (msg.type === 'conn') {
      runtime.accept(handle as Socket, msg.head ? Buffer.from(msg.head, 'base64') : undefined);
      return;
    }
    if (msg.type === 'drain') runtime.drain();
  });
  // Supervisor crash ⇒ the IPC channel closes ⇒ we exit, so systemd restarts the whole set
  // rather than leaving orphaned workers holding sockets nobody routes to (§6).
  process.on('disconnect', () => process.exit(0));
}
