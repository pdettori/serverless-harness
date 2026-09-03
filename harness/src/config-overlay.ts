import { assertValidDigest, digestDirName } from '@sh/config-bundle';
import type { SandboxTransport } from '@sh/k8s-sandbox';

/** Single-quote-escape for safe bash interpolation. Copied from converge.ts:4 by design. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shared, immutable, digest-keyed: safe to reuse across every leaf on this pod. */
export function configCacheDir(digest: string): string {
  return `/workspace/.sh-config/${digestDirName(assertValidDigest(digest))}`;
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
    // Marker so a test's fake transport can tell the probe call from the others by content rather
    // than by call position. A no-op shell comment; keep it if you touch this script.
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
    // pipefail is REQUIRED, not stylistic. Without it the `base64 -d | tar` pipeline reports only
    // tar's status, so a truncated or corrupt stdin can leave base64 failing while tar returns 0 on
    // the partial bytes it did receive — and the script would then chmod, mv and print 'ok' over an
    // incompletely populated shared cache. Safe to use: the transport runs `bash -c`
    // (k8s-sandbox/src/transport.ts:35) and every sandbox variant installs bash.
    `set -euo pipefail`,
    `DIR=${sq(DIR)}; LOCK=/workspace/.sh-config.lock`,
    `mkdir -p /workspace/.sh-config`,
    `TMP="$DIR.tmp.$$"`,
    `(`,
    `  flock 9`,
    // Clean up the staging dir on ANY failure. Without this, `set -e` aborts before the mv and
    // leaves $DIR.tmp.$$ behind — and since each attempt uses a fresh PID, a systemic failure
    // (a transport truncating stdin, say) accumulates stale staging dirs indefinitely on a
    // long-lived pooled sandbox. The canonical path is still never half-populated either way.
    // `chmod -R a-w` below (ADR-0031) makes the staged tree read-only before it can ever fail
    // out of this trap, so the trap must restore write permission first, or `rm -rf` on a
    // read-only tree can itself fail and leak the staging dir on every failure.
    `  trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT`,
    // Benign race, deliberately tolerated rather than fixed: if two leaves both miss the probe,
    // the flock loser reaches this line and exits WITHOUT draining the bundle piped on stdin. The
    // exec transports tolerate an undrained stdin, and overlayConfig only sends bytes on a miss, so
    // the cost is one wasted transfer at worst. Do not "fix" this by draining or by dropping the
    // early exit: the first reintroduces the transfer this optimisation exists to avoid, and the
    // second re-extracts over a populated cache.
    `  # Benign undrained-stdin race: loser exits without draining piped bundle; transports tolerate it.`,
    `  [ -d "$DIR" ] && exit 0`,
    `  rm -rf "$TMP"; mkdir -p "$TMP"`,
    `  base64 -d | tar -x -z -C "$TMP"`,
    `  find "$TMP" -name '*.sh' -exec chmod +x {} +`,
    // ADR-0031: promoted memory (and skill bodies) must be read-only, because this cache is
    // shared by every leaf on the pod and nothing else prevents one leaf's write from mutating
    // what every later leaf on this pod reads. Drop write AFTER the +x pass (so the scripts this
    // cache ships stay executable) and BEFORE the mv (so the canonical path is never briefly
    // writable).
    `  chmod -R a-w "$TMP"`,
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
