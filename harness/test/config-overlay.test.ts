import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  configCacheDir,
  leafConfigDir,
  buildCacheProbeScript,
  buildCachePopulateScript,
  buildLeafBindScript,
  buildConfigCleanupScript,
  overlayConfig,
} from '../src/config-overlay.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);

describe('paths', () => {
  it('caches by digest, shared across leaves', () => {
    expect(configCacheDir(DIGEST)).toBe(`/workspace/.sh-config/sha256-${'a'.repeat(64)}`);
  });
  it('binds per leaf under the leaf workspace, torn down by run-leaf.ts on the prompt-leaf path (buildConfigCleanupScript) or by cleanupWorkspace when the leaf converges', () => {
    expect(leafConfigDir('leaf-1')).toBe('/workspace/leaves/leaf-1/.sh-config');
  });
});

describe('buildCachePopulateScript', () => {
  const s = buildCachePopulateScript(DIGEST);
  it('extracts from stdin base64, never from a heredoc per file', () => {
    expect(s).toContain('base64 -d');
    expect(s).toContain('tar -x');
  });
  it('populates under a flock, matching converge.ts discipline', () => {
    expect(s).toMatch(/flock 9[\s\S]*tar -x[\s\S]*9>"\$LOCK"/);
  });
  it('is idempotent — an existing digest dir is left alone', () => {
    expect(s).toContain('[ -d "$DIR" ] &&');
  });
  it('renames a staging dir into place so a crash cannot half-populate the cache', () => {
    expect(s).toContain('mv ');
  });
  it('makes .sh scripts executable (tar-over-exec does not preserve the bit reliably)', () => {
    expect(s).toContain('chmod +x');
  });
  it('enables pipefail so a failed base64 cannot be masked by a successful tar', () => {
    // Without pipefail the pipeline reports only tar's status, and a truncated stdin would produce
    // exit 0 with an incompletely populated cache.
    expect(s).toContain('set -euo pipefail');
  });

  it('traps EXIT to remove the staging dir, so failures do not accumulate stale dirs', () => {
    expect(s).toMatch(/trap '.*rm -rf "\$TMP"' EXIT/);
    // and the trap must be armed BEFORE extraction, or it cannot clean up a failed extract
    expect(s.indexOf('trap')).toBeLessThan(s.indexOf('base64 -d'));
  });

  it('restores write permission in the trap before rm -rf, so a read-only staged tree can still be removed on failure', () => {
    // ADR-0031 makes the staged tree read-only (chmod -R a-w) before the mv. If the trap's rm -rf
    // ever runs on that read-only tree without first restoring write permission, `rm -rf` can fail
    // to remove it (a directory needs write permission on itself to unlink its own entries), and a
    // staging dir leaks on every failure -- exactly the bug this fix must not introduce.
    expect(s).toMatch(/trap 'chmod -R u\+w "\$TMP".*rm -rf "\$TMP"' EXIT/);
  });

  it('drops write permission on the staged tree (ADR-0031: promoted memory/skills must be read-only) after chmod +x and before the mv', () => {
    const chmodExecIdx = s.indexOf('chmod +x');
    const chmodReadonlyIdx = s.indexOf('chmod -R a-w');
    const mvIdx = s.lastIndexOf('mv "$TMP" "$DIR"');
    expect(chmodExecIdx).toBeGreaterThan(-1);
    expect(chmodReadonlyIdx).toBeGreaterThan(-1);
    expect(mvIdx).toBeGreaterThan(-1);
    // Order matters: +x must land before the tree goes read-only (or the scripts it ships could
    // not be marked executable), and both must land before the mv (so the canonical shared cache
    // is never briefly writable).
    expect(chmodExecIdx).toBeLessThan(chmodReadonlyIdx);
    expect(chmodReadonlyIdx).toBeLessThan(mvIdx);
  });

  it('documents the tolerated undrained-stdin race next to the early exit', () => {
    // A future reader "fixing" this race would either reintroduce the transfer the probe avoids or
    // re-extract over a populated cache, so the reasoning has to live in the source.
    expect(s).toMatch(/race|undrained|tolerat/i);
  });

  it('single-quote-escapes the digest', () => {
    expect(buildCachePopulateScript("x'; rm -rf /; '")).toContain(`'\\''`);
  });
});

describe('buildLeafBindScript', () => {
  const s = buildLeafBindScript(DIGEST, 'leaf-1');
  it('creates the leaf dir and links the shared cache into it', () => {
    expect(s).toContain('mkdir -p');
    expect(s).toContain('/workspace/leaves/leaf-1');
    expect(s).toContain('ln -sfn');
  });
  it('writes nothing outside the leaf path and the digest cache', () => {
    for (const line of s.split('\n')) {
      if (/^\s*(mkdir|ln|rm|mv|chmod)/.test(line)) {
        expect(line).toMatch(/\$LEAF|\$DIR|leaves|\.sh-config/);
      }
    }
  });
});

// Invoked from run-leaf.ts's runPromptLeaf teardown (in the `finally`, guarded on `overlayCreated`)
// for a promoted prompt leaf, which never converges a workspace and so has no other path that would
// ever remove this per-leaf link -- see run-leaf-promoted.test.ts for the wiring-level coverage.
describe('buildConfigCleanupScript', () => {
  it('removes only the per-leaf link, never the shared cache', () => {
    const s = buildConfigCleanupScript('leaf-1');
    expect(s).toContain('/workspace/leaves/leaf-1/.sh-config');
    expect(s).not.toContain('/workspace/.sh-config/sha256');
  });
});

function transportSpy(cacheHit: boolean) {
  const calls: Array<{ command: string; stdinBytes: number }> = [];
  return {
    calls,
    transport: {
      exec: async (command: string, opts?: { stdin?: Buffer }) => {
        calls.push({ command, stdinBytes: opts?.stdin?.length ?? 0 });
        const probing = command.includes('CACHE_PROBE');
        return {
          stdout: Buffer.from(probing && cacheHit ? 'hit' : 'miss'),
          exitCode: 0,
          truncated: false,
        };
      },
      close: async () => {},
    },
  };
}

describe('overlayConfig', () => {
  const tarGz = gzipSync(Buffer.from('fake-tar'));

  it('returns the sandbox skills and memory dirs for the prompt notes', async () => {
    const { transport } = transportSpy(true);
    expect(await overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).toEqual({
      skillsDir: '/workspace/leaves/leaf-1/.sh-config/skills',
      memoryDir: '/workspace/leaves/leaf-1/.sh-config/memory',
    });
  });

  it('pushes no bytes when the digest is already cached (the fan-out win)', async () => {
    const { transport, calls } = transportSpy(true);
    await overlayConfig(transport, DIGEST, 'leaf-1', tarGz);
    expect(calls.every((c) => c.stdinBytes === 0)).toBe(true);
    expect(calls).toHaveLength(2); // probe + bind
  });

  it('pushes the bundle exactly once when the cache is cold', async () => {
    const { transport, calls } = transportSpy(false);
    await overlayConfig(transport, DIGEST, 'leaf-1', tarGz);
    expect(calls.filter((c) => c.stdinBytes > 0)).toHaveLength(1);
    expect(calls).toHaveLength(3); // probe + populate + bind
  });

  it('throws on a non-zero exit rather than continuing unconfigured', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 1, truncated: false }),
      close: async () => {},
    };
    await expect(overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).rejects.toThrow(/overlay/);
  });

  it('throws when the overlay output is truncated', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: null, truncated: true }),
      close: async () => {},
    };
    await expect(overlayConfig(transport, DIGEST, 'leaf-1', tarGz)).rejects.toThrow(/output cap/);
  });
});
