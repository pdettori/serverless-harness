import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  clearAuth,
  loadAuth,
  loadConfig,
  normalizeUrl,
  resolveEndpoints,
  resolvePaths,
  saveAuth,
  saveConfig,
  type CachedAuth,
} from '../src/config.js';

const tmpHome = () => mkdtempSync(join(tmpdir(), 'sh-tui-'));

describe('resolvePaths', () => {
  it('uses XDG dirs when set', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s' }, '/home/u');
    expect(p.configFile).toBe('/c/sh-tui/config.json');
    expect(p.authFile).toBe('/c/sh-tui/auth.json');
    expect(p.transcriptsDir).toBe('/s/sh-tui/transcripts');
    expect(p.exportsDir).toBe('/s/sh-tui/exports');
  });

  it('falls back to ~/.config and ~/.local/state', () => {
    const p = resolvePaths({}, '/home/u');
    expect(p.configDir).toBe('/home/u/.config/sh-tui');
    expect(p.stateDir).toBe('/home/u/.local/state/sh-tui');
  });
});

describe('loadConfig / saveConfig', () => {
  it('returns defaults and exists=false when there is no file', () => {
    const paths = resolvePaths({}, tmpHome());
    expect(loadConfig(paths)).toEqual({ config: DEFAULT_CONFIG, exists: false });
  });

  it('round-trips and merges over defaults', () => {
    const paths = resolvePaths({}, tmpHome());
    saveConfig(paths, { ...DEFAULT_CONFIG, harnessUrl: 'http://h', theme: 'dark' });
    const { config, exists } = loadConfig(paths);
    expect(exists).toBe(true);
    expect(config.harnessUrl).toBe('http://h');
    expect(config.theme).toBe('dark');
    expect(config.presets).toEqual([]);
  });

  it('falls back to defaults with a warning on malformed JSON', () => {
    const paths = resolvePaths({}, tmpHome());
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, '{ "theme": "dark", ');
    const loaded = loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.exists).toBe(true);
    expect(loaded.warning).toMatch(/ignoring unreadable .*config\.json/);
  });

  it('rejects a JSON value that is not an object', () => {
    const paths = resolvePaths({}, tmpHome());
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, '[1,2]');
    expect(loadConfig(paths).warning).toBeDefined();
  });
});

describe('auth cache', () => {
  const auth: CachedAuth = {
    apiToken: 'tok', // notsecret
    subject: 'github:1',
    roles: [],
    expiresAt: 2_000_000_000,
    controlPlaneUrl: 'http://cp',
  };

  it('writes auth.json with mode 0600 in a 0700 directory', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    expect(statSync(paths.authFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(paths.authFile, 'utf8')).subject).toBe('github:1');
  });

  it('returns null for a different control plane', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    expect(loadAuth(paths, 'http://cp')?.apiToken).toBe('tok');
    expect(loadAuth(paths, 'http://other')).toBeNull();
  });

  it('clearAuth removes the file and is idempotent', () => {
    const paths = resolvePaths({}, tmpHome());
    saveAuth(paths, auth);
    clearAuth(paths);
    clearAuth(paths);
    expect(loadAuth(paths, 'http://cp')).toBeNull();
  });
});

describe('endpoints', () => {
  it('normalizes whitespace, empty strings and trailing slashes', () => {
    expect(normalizeUrl('  http://h/cp/  ')).toBe('http://h/cp');
    expect(normalizeUrl('')).toBeUndefined();
    expect(normalizeUrl(undefined)).toBeUndefined();
  });

  it('prefers flag over env over config', () => {
    const config = { ...DEFAULT_CONFIG, controlPlaneUrl: 'http://cfg', harnessUrl: 'http://cfg-h' };
    const env = { SH_CONTROL_PLANE_URL: 'http://env', SH_HARNESS_URL: '' };
    expect(resolveEndpoints({ controlPlaneUrl: 'http://flag/' }, env, config)).toEqual({
      controlPlaneUrl: 'http://flag',
      harnessUrl: 'http://cfg-h',
    });
    expect(resolveEndpoints({}, env, config).controlPlaneUrl).toBe('http://env');
  });
});
