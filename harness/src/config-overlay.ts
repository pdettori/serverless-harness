import { digestDirName } from '@sh/config-bundle';
import type { SandboxTransport } from '@sh/k8s-sandbox';

/** Single-quote-escape for safe bash interpolation. Copied from converge.ts:4 by design. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shared, immutable, digest-keyed: safe to reuse across every leaf on this pod. */
export function configCacheDir(digest: string): string {
  return `/workspace/.sh-config/${digestDirName(digest)}`;
}

/** Per-leaf link, under the leaf workspace so `cleanupWorkspace` remains the only teardown path. */
export function leafConfigDir(runId: string): string {
  return `/workspace/leaves/${runId}/.sh-config`;
}

export interface OverlayPaths {
  skillsDir: string;
  memoryDir: string;
}

/** Prints `hit` when the digest is already cached, `miss` otherwise. */
export function buildCacheProbeScript(digest: string): string {
  return [
    `set -eu`,
    `# CACHE_PROBE`,
    `DIR=${sq(configCacheDir(digest))}`,
    `if [ -d "$DIR" ]; then printf 'hit'; else printf 'miss'; fi`,
  ].join('\n');
}

/**
 * Populate the shared cache from base64 tar.gz on stdin, under the same per-pod flock
 * `converge.ts` uses, so concurrent leaves on a cold pod do not race. Staged then renamed, so
 * a crash cannot leave a half-populated cache that would truncate skill instructions.
 */
export function buildCachePopulateScript(digest: string): string {
  const DIR = configCacheDir(digest);
  return [
    `set -eu`,
    `DIR=${sq(DIR)}; LOCK=/workspace/.sh-config.lock`,
    `mkdir -p /workspace/.sh-config`,
    `TMP="$DIR.tmp.$$"`,
    `(`,
    `  flock 9`,
    `  [ -d "$DIR" ] && exit 0`,
    `  rm -rf "$TMP"; mkdir -p "$TMP"`,
    `  base64 -d | tar -x -z -C "$TMP"`,
    `  find "$TMP" -name '*.sh' -exec chmod +x {} +`,
    `  mv "$TMP" "$DIR"`,
    `) 9>"$LOCK"`,
    `printf 'ok'`,
  ].join('\n');
}

/** Link the shared cache into this leaf's workspace and echo the leaf-local root. */
export function buildLeafBindScript(digest: string, runId: string): string {
  const LEAF = leafConfigDir(runId);
  return [
    `set -eu`,
    `DIR=${sq(configCacheDir(digest))}; LEAF=${sq(LEAF)}`,
    `mkdir -p "$(dirname "$LEAF")"`,
    `ln -sfn "$DIR" "$LEAF"`,
    `printf '%s' "$LEAF"`,
  ].join('\n');
}

/** Drop only the per-leaf link. The shared cache is immutable and outlives every leaf. */
export function buildConfigCleanupScript(runId: string): string {
  return [`set -u`, `rm -f ${sq(leafConfigDir(runId))} 2>/dev/null || true`].join('\n');
}

async function run(transport: SandboxTransport, script: string, stdin?: Buffer): Promise<string> {
  const { stdout, exitCode, truncated } = await transport.exec(script, {
    timeout: 300,
    ...(stdin ? { stdin } : {}),
  });
  if (truncated) throw new Error('config overlay exceeded the sandbox output cap');
  if (exitCode !== 0) throw new Error(`config overlay failed (exit ${exitCode})`);
  return stdout.toString();
}

/**
 * Mirror the bundle into the sandbox and return the paths the injected prompt notes name.
 *
 * Probes first and pushes bytes only on a miss: bundles are immutable and content-addressed, so
 * a 200-leaf fan-out transfers the bundle once rather than 200 times (spec §4.5).
 */
export async function overlayConfig(
  transport: SandboxTransport,
  digest: string,
  runId: string,
  tarGz: Buffer,
): Promise<OverlayPaths> {
  const probe = await run(transport, buildCacheProbeScript(digest));
  if (probe.trim() !== 'hit') {
    await run(transport, buildCachePopulateScript(digest), Buffer.from(tarGz.toString('base64')));
  }
  await run(transport, buildLeafBindScript(digest, runId));
  const root = leafConfigDir(runId);
  return { skillsDir: `${root}/skills`, memoryDir: `${root}/memory` };
}
