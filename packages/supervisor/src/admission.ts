import type { Socket } from 'node:net';
import type { WorkerView } from './routing.js';

/**
 * One second. Long enough for a burst edge to clear at the turn durations E6 measured, short
 * enough that a driver's retry still lands inside the rung it belongs to.
 */
export const RETRY_AFTER_SECONDS = 1;

/**
 * True ⇒ no healthy worker is below the per-worker in-flight turn cap S (§3.8).
 *
 * Unhealthy workers are excluded rather than counted as empty: a restarting worker reports
 * inFlight 0, which would read as free capacity that does not exist. With no healthy worker
 * at all this returns true, so the caller answers with back-pressure instead of parking the
 * connection until a fork completes.
 */
export function isSaturated(workers: readonly WorkerView[], turnsPerWorker: number): boolean {
  return !workers.some((wv) => wv.healthy && wv.inFlight < turnsPerWorker);
}

const BODY = '{"error":"overloaded"}';

/**
 * Refuse a connection with `429` + `Retry-After`, **before** hand-off (§3.5, #55).
 *
 * Written straight onto the socket because the supervisor's listener is a `net.Server`: it
 * has to be, since hand-off passes the socket itself. Admitting the connection and failing
 * inside a worker instead would turn clean back-pressure into a mid-turn error and would
 * corrupt E8's rungs by counting admitted-but-doomed turns.
 */
export function refuse(socket: Socket, opts: { retryAfterSeconds?: number } = {}): void {
  const retryAfter = opts.retryAfterSeconds ?? RETRY_AFTER_SECONDS;
  // Drain the readable side before ending it: a paused socket (no `'data'` listener) never
  // observes the peer's FIN, so without this it stays half-open and `server.close()` never
  // fires its `'close'` event. This runs after the admission decision, so it is not a §3.5
  // read — no byte here informs the refusal, and with no `'data'` listener the bytes are
  // discarded, not parsed.
  socket.resume();
  socket.end(
    `HTTP/1.1 429 Too Many Requests\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(BODY, 'utf8')}\r\n` +
      `Retry-After: ${retryAfter}\r\n` +
      `Connection: close\r\n` +
      `\r\n${BODY}`,
  );
}
