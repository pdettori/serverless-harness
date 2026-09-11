import { fork } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSaturated, refuse } from './admission.js';
import { startAdminServer } from './admin.js';
import { readConfig, type SupervisorConfig } from './config.js';
import { readHead, sessionIdFromHead } from './head.js';
import { WorkerPool, type WorkerHandle } from './pool.js';

export interface Supervisor {
  readonly port: number;
  readonly adminPort: number;
  readonly pool: WorkerPool;
  close(): Promise<void>;
}

/**
 * The worker entry point, resolved through the pnpm workspace layout rather than a package
 * export: spec §9 keeps `@sh/knative-server`'s public surface at `startServer` only, and the
 * supervisor forks this file as a process, so it needs a path and not an import.
 */
export const DEFAULT_WORKER_ENTRY = fileURLToPath(
  new URL('../../knative-server/src/worker.ts', import.meta.url),
);

export async function startSupervisor(opts: {
  config: SupervisorConfig;
  workerEntry?: string;
  log?: (line: Record<string, unknown>) => void;
}): Promise<Supervisor> {
  const { config } = opts;
  const workerEntry = opts.workerEntry ?? DEFAULT_WORKER_ENTRY;
  const log = opts.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));

  const pool = new WorkerPool({
    workers: config.workers,
    restartBackoffMs: config.restartBackoffMs,
    log,
    fork: (id) =>
      // execArgv is inherited, so a supervisor started under `--import tsx` forks TypeScript
      // workers without a second loader flag.
      fork(workerEntry, ['--role=turn'], {
        stdio: 'inherit',
        env: { ...process.env, SH_WORKER_ID: String(id) },
      }) as unknown as WorkerHandle,
  });

  // pauseOnConnect: without it, Node starts reading each accepted socket into its own
  // JS-level buffer before this callback even runs (net.Server's default). Those bytes would
  // never reach the worker: only the OS-level fd is duplicated across the hand-off, not
  // whatever the parent already pulled into userspace. Staying paused keeps every byte in the
  // kernel socket buffer until the worker's own reader starts it, which is what makes "the
  // supervisor reads no byte of the request" (below) actually true for policies that don't
  // pre-read the head.
  const server: Server = createServer({ pauseOnConnect: true }, (socket: Socket) => {
    void route(socket);
  });

  async function route(socket: Socket): Promise<void> {
    // Admission FIRST, and before any read: §3.5 puts the 429 before hand-off, and refusing
    // without touching the request also means a saturated supervisor does no per-connection
    // parsing work at exactly the moment it has none to spare.
    if (isSaturated(pool.views(), config.turnsPerWorker)) {
      pool.noteRefusal();
      refuse(socket);
      return;
    }

    let head: Buffer | undefined;
    let sessionId: string | undefined;
    if (config.policy.needsHead) {
      const read = await readHead(socket);
      head = read.bytes;
      // An incomplete head still routes: the supervisor does not adjudicate HTTP, so the
      // worker's parser issues the 400 (or completes the request) as it would have anyway.
      sessionId = read.complete ? sessionIdFromHead(read.bytes) : undefined;
    }

    const chosen = config.policy.pick(pool.views(), { sessionId });
    if (chosen === undefined) {
      // Every worker went unhealthy between the check and here — a restart window.
      pool.noteRefusal();
      refuse(socket);
      return;
    }
    pool.handOff(chosen, socket, head);
    // From here the supervisor is entirely off the data path (§3.2). It holds no reference to
    // the socket, reads no byte of the request, and writes no byte of the response.
  }

  server.listen(config.port, '0.0.0.0');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log({ event: 'supervisor_listening', port, workers: config.workers, policy: config.policy.name });

  // Separate listener from the data-path `net.Server` above: an `http.Server` here would add
  // per-connection HTTP parsing to the hot path for every worker connection, not just /metrics.
  const admin = await startAdminServer({ pool, port: config.adminPort, env: process.env });
  log({ event: 'admin_listening', port: admin.port });

  return {
    port,
    adminPort: admin.port,
    pool,
    async close(): Promise<void> {
      await admin.close();
      server.close();
      pool.drainAll();
      await once(server, 'close');
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const supervisor = await startSupervisor({ config: readConfig(process.env) });
  const shutdown = (): void => {
    void supervisor.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
