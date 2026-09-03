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
  it('binds per leaf under the leaf workspace, so cleanupWorkspace still owns teardown', () => {
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
