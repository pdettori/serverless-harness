import type { Socket } from 'node:net';

/** Matches Node's own `maxHeaderSize` default, so this is not a second, stricter limit. */
export const MAX_HEAD_BYTES = 8192;

const TERMINATOR = Buffer.from('\r\n\r\n');

/** Index just past the terminating CRLFCRLF, or -1 if the header block is incomplete. */
export function headerBlockEnd(buf: Buffer): number {
  const at = buf.indexOf(TERMINATOR);
  return at === -1 ? -1 : at + TERMINATOR.length;
}

/**
 * `X-SH-Session-Id` from the header block only. Scanning past the terminator would let a
 * client steer routing from its request body.
 */
export function sessionIdFromHead(head: Buffer): string | undefined {
  const end = headerBlockEnd(head);
  const block = end === -1 ? head : head.subarray(0, end);
  for (const line of block.toString('latin1').split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'x-sh-session-id') continue;
    const value = line.slice(colon + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

export interface HeadRead {
  /** EVERY byte consumed from the socket: header block plus any body bytes that rode along. */
  readonly bytes: Buffer;
  /** False ⇒ cap or timeout hit first. Route blind; the worker's parser rules on the request. */
  readonly complete: boolean;
}

/**
 * Read just enough to route a sticky connection, then stop.
 *
 * Two invariants, both load-bearing because the socket travels onward as a file descriptor:
 *  1. every byte consumed here is returned, so it can be replayed into the worker's stream;
 *  2. the socket is paused on resolve, so nothing further is consumed before hand-off.
 */
export function readHead(
  socket: Socket,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<HeadRead> {
  const maxBytes = opts.maxBytes ?? MAX_HEAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? 2000;

  return new Promise<HeadRead>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      // Paused before the fd is handed over: invariant 2.
      socket.pause();
      resolve({ bytes: Buffer.concat(chunks), complete });
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (headerBlockEnd(Buffer.concat(chunks)) !== -1) {
        finish(true);
        return;
      }
      // Over the cap we stop reading but keep what we have: the bytes are already out of the
      // kernel buffer, so discarding them would corrupt the request the worker sees.
      if (total >= maxBytes) finish(false);
    };
    const onEnd = (): void => finish(false);

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
    // Required, not defensive: main.ts's server is created with `pauseOnConnect: true`, so
    // attaching the 'data' listener above does not itself start the flow. Without this resume(),
    // a sticky-routed connection would just sit there — no data, no error, no timeout firing
    // early enough to matter.
    socket.resume();
  });
}
