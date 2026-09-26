import { homedir } from 'node:os';
import { ControlPlaneClient } from './api/control-plane.js';
import { HarnessClient } from './api/harness.js';
import type { ControlPlaneApi, HarnessApi } from './api/types.js';
import {
  clearAuth,
  loadAuth,
  loadConfig,
  normalizeUrl,
  resolveEndpoints,
  resolvePaths,
  saveAuth,
  saveConfig,
  type CachedAuth,
  type Endpoints,
  type Paths,
  type TuiConfig,
} from './config.js';
import { sleep } from './core/time.js';
import { TranscriptStore } from './core/transcripts.js';

export interface Runtime {
  paths: Paths;
  config: TuiConfig;
  configExists: boolean;
  configWarning?: string;
  endpoints: Endpoints;
  auth: CachedAuth | null;
  cp?: ControlPlaneApi;
  harness?: HarnessApi;
  transcripts?: TranscriptStore;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl: typeof fetch;
}

// The transcript store is per subject and per control plane (spec §6.6), so it follows the login.
function wireTranscripts(rt: Runtime): void {
  const { controlPlaneUrl } = rt.endpoints;
  rt.transcripts =
    rt.auth && controlPlaneUrl
      ? new TranscriptStore(rt.paths.transcriptsDir, { subject: rt.auth.subject, controlPlaneUrl })
      : undefined;
}

// The control-plane client reads rt.auth on every request, so a new login needs no new client.
function wire(rt: Runtime): void {
  const { controlPlaneUrl, harnessUrl } = rt.endpoints;
  rt.cp = controlPlaneUrl
    ? new ControlPlaneClient(controlPlaneUrl, () => rt.auth?.apiToken, rt.fetchImpl)
    : undefined;
  rt.harness = harnessUrl ? new HarnessClient(harnessUrl, rt.fetchImpl) : undefined;
  wireTranscripts(rt);
}

export function buildRuntime(
  flags: Endpoints,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
  fetchImpl: typeof fetch = fetch,
): Runtime {
  const paths = resolvePaths(env, home);
  const loaded = loadConfig(paths);
  const endpoints = resolveEndpoints(flags, env, loaded.config);
  const rt: Runtime = {
    paths,
    config: loaded.config,
    configExists: loaded.exists,
    configWarning: loaded.warning,
    endpoints,
    auth: endpoints.controlPlaneUrl ? loadAuth(paths, endpoints.controlPlaneUrl) : null,
    now: Date.now,
    sleep,
    fetchImpl,
  };
  wire(rt);
  return rt;
}

export function setAuth(rt: Runtime, auth: CachedAuth | null): void {
  rt.auth = auth;
  if (auth) saveAuth(rt.paths, auth);
  else clearAuth(rt.paths);
  wireTranscripts(rt);
}

export function saveRuntimeConfig(rt: Runtime): void {
  saveConfig(rt.paths, rt.config);
  rt.configExists = true;
}

export function setEndpoints(rt: Runtime, endpoints: Endpoints): void {
  rt.endpoints = {
    controlPlaneUrl: normalizeUrl(endpoints.controlPlaneUrl),
    harnessUrl: normalizeUrl(endpoints.harnessUrl),
  };
  // A token is only ever sent to the control plane that issued it (spec §4.6).
  rt.auth = rt.endpoints.controlPlaneUrl ? loadAuth(rt.paths, rt.endpoints.controlPlaneUrl) : null;
  rt.config = { ...rt.config, ...rt.endpoints };
  saveRuntimeConfig(rt);
  wire(rt);
}
