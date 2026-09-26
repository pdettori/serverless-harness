import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface Paths {
  configDir: string;
  stateDir: string;
  configFile: string;
  authFile: string;
  transcriptsDir: string;
  exportsDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv, home: string): Paths {
  const configDir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'sh-tui');
  const stateDir = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'sh-tui');
  return {
    configDir,
    stateDir,
    configFile: join(configDir, 'config.json'),
    authFile: join(configDir, 'auth.json'),
    transcriptsDir: join(stateDir, 'transcripts'),
    exportsDir: join(stateDir, 'exports'),
  };
}

export interface Preset {
  name: string;
  values: Record<string, string>;
}

export interface TuiConfig {
  controlPlaneUrl?: string;
  harnessUrl?: string;
  theme: 'system' | 'dark';
  details: boolean;
  thinking: boolean;
  reducedMotion: boolean;
  bell: boolean;
  keybinds: Record<string, string>;
  presets: Preset[];
  lastUsed: Record<string, string>;
}

export const DEFAULT_CONFIG: TuiConfig = {
  theme: 'system',
  details: false,
  thinking: true,
  reducedMotion: false,
  bell: true,
  keybinds: {},
  presets: [],
  lastUsed: {},
};

export function loadConfig(paths: Paths): { config: TuiConfig; exists: boolean; warning?: string } {
  if (!existsSync(paths.configFile)) return { config: { ...DEFAULT_CONFIG }, exists: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
    return { config: { ...DEFAULT_CONFIG, ...(raw as Partial<TuiConfig>) }, exists: true };
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG },
      exists: true,
      warning: `ignoring unreadable ${paths.configFile}: ${(err as Error).message}`,
    };
  }
}

// Write-then-rename so a crash never leaves a half-written file; chmod because the create mode is
// masked by the umask.
function writePrivate(path: string, dir: string, data: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveConfig(paths: Paths, config: TuiConfig): void {
  writePrivate(paths.configFile, paths.configDir, JSON.stringify(config, null, 2) + '\n');
}

export interface CachedAuth {
  apiToken: string;
  subject: string;
  displayName?: string;
  roles: string[];
  expiresAt: number;
  controlPlaneUrl: string;
}

export function loadAuth(paths: Paths, controlPlaneUrl: string): CachedAuth | null {
  try {
    const auth = JSON.parse(readFileSync(paths.authFile, 'utf8')) as CachedAuth;
    if (typeof auth.apiToken !== 'string' || auth.controlPlaneUrl !== controlPlaneUrl) return null;
    return auth;
  } catch {
    return null;
  }
}

export function saveAuth(paths: Paths, auth: CachedAuth): void {
  writePrivate(paths.authFile, paths.configDir, JSON.stringify(auth) + '\n');
}

export function clearAuth(paths: Paths): void {
  rmSync(paths.authFile, { force: true });
}

export interface Endpoints {
  controlPlaneUrl?: string;
  harnessUrl?: string;
}

export function normalizeUrl(u?: string): string | undefined {
  const t = u?.trim();
  return t ? t.replace(/\/+$/, '') : undefined;
}

export function resolveEndpoints(
  flags: Endpoints,
  env: NodeJS.ProcessEnv,
  config: TuiConfig,
): Endpoints {
  return {
    controlPlaneUrl: normalizeUrl(
      flags.controlPlaneUrl || env.SH_CONTROL_PLANE_URL || config.controlPlaneUrl,
    ),
    harnessUrl: normalizeUrl(flags.harnessUrl || env.SH_HARNESS_URL || config.harnessUrl),
  };
}
