import { describe, it, expect } from 'vitest';
import { buildBundle, canonicalTar, contentDigest, untar } from '@sh/config-bundle';
import {
  bundleKey,
  putBundle,
  getBundle,
  BundleNotFoundError,
  BundleDigestMismatchError,
  DEFAULT_BUNDLE_TTL_SECONDS,
  type BundleRedisLike,
} from '../src/config-store.js';

/** In-memory fake, mirroring the RedisLike pattern in leaf-result-store.ts. */
function fakeRedis(): BundleRedisLike & { store: Map<string, string>; sets: number } {
  const store = new Map<string, string>();
  return {
    store,
    sets: 0,
    async set(key, value) {
      this.sets++;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
  };
}

const tar = canonicalTar([
  { path: 'skills/x/SKILL.md', content: Buffer.from('---\nname: x\n---\nb') },
]);
const digest = contentDigest(untar(tar)); // computed from tar: verification ensures round-trip fidelity

describe('bundleKey', () => {
  it('namespaces by digest', () => {
    expect(bundleKey('sha256:abc')).toBe('config:bundle:sha256:abc');
  });
});

describe('putBundle', () => {
  it('uploads when absent and reports uploaded: true', async () => {
    const r = fakeRedis();
    expect(await putBundle(r, digest, tar)).toEqual({ uploaded: true });
    expect(r.store.has(bundleKey(digest))).toBe(true);
  });

  it('is a no-op when the digest is already present (re-promotion is free)', async () => {
    const r = fakeRedis();
    await putBundle(r, digest, tar);
    const before = r.sets;
    expect(await putBundle(r, digest, tar)).toEqual({ uploaded: false });
    expect(r.sets).toBe(before);
  });

  it('sets a TTL', async () => {
    const seen: Array<{ EX?: number } | undefined> = [];
    const r = fakeRedis();
    const spy: BundleRedisLike = { ...r, set: async (k, v, o) => (seen.push(o), r.set(k, v, o)) };
    await putBundle(spy, digest, tar);
    expect(seen[0]).toEqual({ EX: DEFAULT_BUNDLE_TTL_SECONDS });
  });
});

describe('getBundle', () => {
  it('round-trips the exact bytes', async () => {
    const r = fakeRedis();
    await putBundle(r, digest, tar);
    expect((await getBundle(r, digest)).equals(tar)).toBe(true);
  });

  it('throws BundleNotFoundError with the digest in the message', async () => {
    await expect(getBundle(fakeRedis(), digest)).rejects.toThrow(BundleNotFoundError);
    await expect(getBundle(fakeRedis(), digest)).rejects.toThrow(digest);
  });

  it('throws BundleDigestMismatchError on corrupted stored bytes', async () => {
    const r = fakeRedis();
    const real = buildBundle({
      roots: {},
      entry: 'e',
      mode: 'unattended',
      sandboxImage: 'i',
      versions: { pi: '1', harness: '1' },
    });
    await putBundle(r, real.digest, real.tar);
    // corrupt the stored payload
    r.store.set(bundleKey(real.digest), Buffer.from('not a tar').toString('base64'));
    await expect(getBundle(r, real.digest)).rejects.toThrow(BundleDigestMismatchError);
  });

  it('accepts a bundle whose recomputed content digest matches', async () => {
    const r = fakeRedis();
    const real = buildBundle({
      roots: {},
      entry: 'e',
      mode: 'unattended',
      sandboxImage: 'i',
      versions: { pi: '1', harness: '1' },
    });
    await putBundle(r, real.digest, real.tar);
    expect((await getBundle(r, real.digest)).equals(real.tar)).toBe(true);
  });
});
