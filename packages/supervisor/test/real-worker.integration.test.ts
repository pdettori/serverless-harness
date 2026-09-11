import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readConfig } from '../src/config.js';
import { startSupervisor, DEFAULT_WORKER_ENTRY, type Supervisor } from '../src/main.js';

/**
 * The only test that forks the REAL worker at `DEFAULT_WORKER_ENTRY`. Every other integration
 * test substitutes a hand-written `.mjs` fixture, which papers over precisely the things this
 * file exercises: forking a cross-package `.ts` file through inherited `--import tsx` execArgv,
 * `worker.ts`'s `pathToFileURL` main-module guard, its `process.send` presence check, and
 * `handler`'s import graph resolving from a foreign package root.
 *
 * It is also what makes the recorded justification for duplicating `WorkerToSupervisor` across
 * `supervisor/src/pool.ts` and `knative-server/src/worker.ts` true rather than aspirational:
 * the two copies must agree on the wire or these tests fail.
 */

/**
 * Production runs `node --import tsx src/main.ts` and `fork()` inherits execArgv, which is how
 * a TypeScript worker starts with no second loader flag. Under vitest the parent's execArgv is
 * `['--conditions', 'development', ...]` with no loader, and a bare `node worker.ts` dies with
 * `ERR_INVALID_TYPESCRIPT_SYNTAX` on `TurnCounter`'s parameter property (Node's strip-only mode
 * cannot compile it). Setting execArgv here exercises the real inheritance path rather than
 * adding a test-only option to `startSupervisor`.
 */
async function withRealWorker(
  extraEnv: Record<string, string>,
): Promise<{ sup: Supervisor; restore: () => void }> {
  const saved = process.execArgv;
  process.execArgv = ['--import', 'tsx'];
  // Restored in afterEach rather than here: a worker restart mid-test forks again and must
  // inherit the loader too.
  const restore = (): void => {
    process.execArgv = saved;
  };
  try {
    const sup = await startSupervisor({
      config: readConfig({
        PORT: '0',
        SH_ADMIN_PORT: '0',
        SH_WORKERS: '1',
        // Keep the advisory stats row quiet enough not to interleave with the assertions.
        SH_STATS_INTERVAL_MS: '60000',
        ...extraEnv,
      } as NodeJS.ProcessEnv),
      // workerEntry deliberately OMITTED: this is the point of the file.
      log: () => {},
    });
    return { sup, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

/** One request on its own connection, read to completion. */
async function speak(port: number, request: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  const chunks: Buffer[] = [];
  socket.on('data', (c: Buffer) => chunks.push(c));
  await once(socket, 'end');
  socket.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

const HEALTH = 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';

let sup: Supervisor | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  await sup?.close();
  sup = undefined;
  restore?.();
  restore = undefined;
});

describe('the real worker, forked from DEFAULT_WORKER_ENTRY', () => {
  it('serves a non-turn request through a handed-off socket', async () => {
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '8' }));
    await vi.waitFor(() => expect(sup!.pool.views().filter((v) => v.healthy)).toHaveLength(1), {
      timeout: 30_000,
    });
    // `GET /health` is the furthest a test can drive the real handler with no infrastructure:
    // it answers from `server.ts` directly, touching neither Redis nor a sandbox nor a model.
    expect(await speak(sup!.port, HEALTH)).toContain('200 OK');
  }, 60_000);

  it('does not wedge into permanent 429s after non-turn connections at S=1', async () => {
    // THE regression pin for the monotonic-estimate defect. `handOff` credits +1 per admitted
    // CONNECTION while the worker reports `load` only from its TURN counter, and a non-turn
    // request never touches that counter. So each `GET /health` used to raise the estimate by
    // one permanently: at S=1 the second connection was refused before hand-off, so no turn
    // could ever arrive to reconcile, and the pool stayed wedged in 429s until a worker
    // crashed. `setup-vm.sh`'s own closing health check burned one unit per invocation.
    //
    // Driven against the REAL worker on purpose: the `.mjs` fixtures re-implement the IPC
    // contract by hand and papered this over.
    ({ sup, restore } = await withRealWorker({ SH_TURNS_PER_WORKER: '1' }));
    await vi.waitFor(() => expect(sup!.pool.views().filter((v) => v.healthy)).toHaveLength(1), {
      timeout: 30_000,
    });

    for (let i = 1; i <= 4; i += 1) {
      expect(await speak(sup!.port, HEALTH), `connection ${i}`).toContain('200 OK');
      // The estimate must come back down, or connection i+1 is refused before hand-off.
      await vi.waitFor(() => expect(sup!.pool.views()[0]!.inFlight).toBe(0), { timeout: 5000 });
    }
  }, 60_000);
});
