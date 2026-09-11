import { describe, it, expect } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { isSaturated, refuse, RETRY_AFTER_SECONDS } from '../src/admission.js';
import type { WorkerView } from '../src/routing.js';

const w = (id: number, inFlight: number, healthy = true): WorkerView => ({ id, inFlight, healthy });

describe('isSaturated', () => {
  it('is false while any healthy worker is below the cap', () => {
    expect(isSaturated([w(0, 4), w(1, 3)], 4)).toBe(false);
  });

  it('is true when every healthy worker is at or above the cap', () => {
    expect(isSaturated([w(0, 4), w(1, 4)], 4)).toBe(true);
    // Above the cap is reachable: over-admission on a kept-alive socket (§3.9).
    expect(isSaturated([w(0, 5), w(1, 4)], 4)).toBe(true);
  });

  it('ignores unhealthy workers, so a restarting worker cannot mask saturation', () => {
    // Its inFlight is 0, which would otherwise read as free capacity that does not exist.
    expect(isSaturated([w(0, 4), w(1, 0, false)], 4)).toBe(true);
  });

  it('is true with no healthy workers at all', () => {
    // During a full restart the honest answer is back-pressure, not a hung connection.
    expect(isSaturated([w(0, 0, false)], 4)).toBe(true);
    expect(isSaturated([], 4)).toBe(true);
  });
});

describe('refuse', () => {
  async function refusalWire(opts?: { retryAfterSeconds?: number }): Promise<string> {
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as { port: number };
    const client = connect(port, '127.0.0.1');
    // Eager capture: 'connect' can fire while we are awaiting 'connection', and a `once()`
    // registered after the fact would never settle.
    const clientConnected = once(client, 'connect');
    const [server] = (await once(listener, 'connection')) as [Socket];
    await clientConnected;
    listener.close();

    const chunks: Buffer[] = [];
    client.on('data', (c: Buffer) => chunks.push(c));
    refuse(server, opts);
    await once(client, 'end');
    client.destroy();
    return Buffer.concat(chunks).toString('utf8');
  }

  it('writes a well-formed 429 with Retry-After and closes the connection', async () => {
    const wire = await refusalWire();
    expect(wire.split('\r\n')[0]).toBe('HTTP/1.1 429 Too Many Requests');
    expect(wire.toLowerCase()).toContain(`retry-after: ${RETRY_AFTER_SECONDS}`);
    expect(wire.toLowerCase()).toContain('connection: close');
    expect(wire).toMatch(/\r\n\r\n\{.*\}$/s);
  });

  it('declares a Content-Length that matches the body byte length', async () => {
    // A wrong length is the classic hand-rolled-HTTP bug: the client waits for bytes that
    // never come, and a load driver reports it as a TIMEOUT — which on an E8 rung looks
    // exactly like the knee we are hunting.
    const wire = await refusalWire();
    const [head, body] = wire.split('\r\n\r\n');
    const declared = Number(/content-length: (\d+)/i.exec(head!)![1]);
    expect(declared).toBe(Buffer.byteLength(body!, 'utf8'));
  });

  it('has a JSON body a driver can classify', async () => {
    const wire = await refusalWire();
    const body = wire.split('\r\n\r\n')[1]!;
    expect(JSON.parse(body)).toEqual({ error: 'overloaded' });
  });

  it('honours an overridden Retry-After', async () => {
    const wire = await refusalWire({ retryAfterSeconds: 7 });
    expect(wire.toLowerCase()).toContain('retry-after: 7');
  });
});
