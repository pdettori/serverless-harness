import { cpus } from 'node:os';
import { policyFromName, type RoutingPolicy } from './routing.js';

export interface SupervisorConfig {
  readonly port: number;
  readonly workers: number;
  /** S — the per-worker soft cap on in-flight TURNS, not sessions (§3.8, §5.1). */
  readonly turnsPerWorker: number;
  readonly policy: RoutingPolicy;
  readonly restartBackoffMs: number;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(n) || n < bounds.min || n > max) {
    throw new Error(`${name}='${raw}' must be an integer in [${bounds.min}, ${max}]`);
  }
  return n;
}

export function readConfig(env: NodeJS.ProcessEnv): SupervisorConfig {
  const rawTurns = env.SH_TURNS_PER_WORKER?.trim();
  if (!rawTurns) {
    // No default on purpose (§3.8): every plausible one either hides the density this slice
    // exists to find or invites the thrash E8 is meant to locate — and unlike the other
    // knobs, its right value is an OUTPUT of E8, not a guess.
    throw new Error(
      'SH_TURNS_PER_WORKER is required and has no default: it is the per-worker cap on ' +
        'in-flight turns (S), and its right value is an output of E8, not a guess',
    );
  }
  return {
    port: readInt(env, 'PORT', 8080, { min: 0, max: 65535 }),
    workers: readInt(env, 'SH_WORKERS', cpus().length, { min: 1 }),
    turnsPerWorker: readInt(env, 'SH_TURNS_PER_WORKER', 0, { min: 1 }),
    policy: policyFromName(env.SH_ROUTING_POLICY),
    restartBackoffMs: readInt(env, 'SH_WORKER_RESTART_BACKOFF_MS', 250, { min: 0 }),
  };
}
