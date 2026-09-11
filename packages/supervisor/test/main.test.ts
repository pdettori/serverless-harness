import { describe, it, expect } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { startSupervisor } from '../src/main.js';

// A worker that comes up, reports ready, and serves nothing. Enough to prove the supervisor
// binds, forks, and refuses when the pool is at cap.
const inertWorker = fileURLToPath(new URL('./fixtures/inert-worker.mjs', import.meta.url));

describe('startSupervisor', () => {
  it('binds the configured port and forks the pool', async () => {
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
      } as NodeJS.ProcessEnv),
      workerEntry: inertWorker,
      log: () => {},
    });
    expect(sup.port).toBeGreaterThan(0);
    expect(sup.pool.size).toBe(1);
    await sup.close();
  });

  it('refuses with 429 while no worker is ready yet', async () => {
    // Not a contrived state: it is every restart window, and a hang here would look like a
    // saturation knee on an E8 rung.
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        SH_TURNS_PER_WORKER: '1',
      } as NodeJS.ProcessEnv),
      workerEntry: fileURLToPath(new URL('./fixtures/silent-worker.mjs', import.meta.url)),
      log: () => {},
    });
    const client = connect(sup.port, '127.0.0.1');
    await once(client, 'connect');
    client.write('POST /turn HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
    const chunks: Buffer[] = [];
    client.on('data', (c: Buffer) => chunks.push(c));
    await once(client, 'end');
    expect(Buffer.concat(chunks).toString()).toContain('429 Too Many Requests');
    client.destroy();
    await sup.close();
  });
});
