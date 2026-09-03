import { canonicalTar, digestOf } from './tar.js';
import { BUNDLE_FORMAT_VERSION } from './types.js';
import type { BundleLockfile, LockfileInput, ResolvedSkill, TarEntry } from './types.js';

/** Content address of one skill's subtree, so a lockfile diff shows which skills changed. */
export function skillContentHash(skill: ResolvedSkill, entries: TarEntry[]): string {
  const prefix = `skills/${skill.name}/`;
  return digestOf(canonicalTar(entries.filter((e) => e.path.startsWith(prefix))));
}

export function buildLockfile(input: LockfileInput): BundleLockfile {
  return {
    binaries: [...input.binaries].sort(),
    builtAgainst: { harness: input.versions.harness, pi: input.versions.pi },
    context: [...input.contextPaths].sort(),
    digest: input.digest,
    dropped: [...input.classification.dropped].sort((a, b) => a.name.localeCompare(b.name)),
    entry: input.entry,
    formatVersion: BUNDLE_FORMAT_VERSION,
    interactionDependent: [...input.classification.interactionDependent].sort(),
    memory: [...input.memoryPaths].sort(),
    mode: input.mode,
    sandboxImage: input.sandboxImage,
    skills: input.classification.travels
      .map((s) => ({
        name: s.name,
        scope: s.scope,
        sourceDir: s.dir,
        contentHash: input.skillHashes[s.name] ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Sorted-key JSON with a trailing newline: the lockfile is committed and must diff legibly. */
export function serializeLockfile(lockfile: BundleLockfile): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, sortKeys(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sortKeys(lockfile), null, 2) + '\n';
}
