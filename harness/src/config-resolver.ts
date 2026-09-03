import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { digestDirName, untar, type TarEntry } from '@sh/config-bundle';
import { getBundle, type BundleRedisLike } from './config-store.js';

/** The harness pod mounts no writable volume except an emptyDir /tmp (ADR-0020). */
export const DEFAULT_CONFIG_BASE_DIR = '/tmp/sh-config';

export interface PromotedConfig {
  digest: string;
  root: string;
  skillsDir: string;
  promptsDir: string;
  /** Injected inline via agentsFilesOverride — never written to disk. */
  context: Array<{ path: string; content: string }>;
  promptFragments: string[];
  /** The whole bundle, handed to the sandbox overlay so both halves share one digest. */
  entries: TarEntry[];
}

export interface PromotedLoaderOptions {
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
  noContextFiles: true;
  noSkills: true;
  noPromptTemplates: true;
  agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  appendSystemPrompt: string[];
}

/**
 * Unpack into a digest-named directory. Digest-keyed means the cache can never be stale, so
 * its death with the pod is correct rather than unfortunate.
 *
 * Unpack goes to a temp dir and is renamed into place: a crash mid-unpack must never leave a
 * half-populated skill directory, which would silently truncate a skill's instructions.
 */
export function unpackBundle(
  tar: Buffer,
  digest: string,
  baseDir: string = DEFAULT_CONFIG_BASE_DIR,
): PromotedConfig {
  const entries = untar(tar);
  const root = join(baseDir, digestDirName(digest));

  if (!existsSync(root)) {
    mkdirSync(baseDir, { recursive: true });
    const staging = mkdtempSync(join(baseDir, '.tmp-'));
    try {
      for (const entry of entries) {
        // Path safety is checked for EVERY entry, before the prefix filter. Checking it after
        // would let a traversal path outside skills//prompts/ be silently skipped rather than
        // rejected, which is a weaker guarantee than "no bundle can write outside its root".
        const target = resolve(staging, entry.path);
        if (target !== staging && !target.startsWith(staging + sep)) {
          throw new Error(`bundle entry escapes the unpack root: ${entry.path}`);
        }
        // Only skills/ and prompts/ need to be files; context/ and prompt/ are read into memory,
        // and memory/ is destined for the sandbox.
        if (!entry.path.startsWith('skills/') && !entry.path.startsWith('prompts/')) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.content, { mode: entry.mode ?? 0o644 });
      }
      mkdirSync(join(staging, 'skills'), { recursive: true });
      mkdirSync(join(staging, 'prompts'), { recursive: true });
      renameSync(staging, root);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      // An EEXIST/ENOTEMPTY rename means a concurrent turn in this pod won the race; that is
      // fine, because identical digests mean identical content.
      if (!existsSync(root)) throw err;
    }
  }

  // Numeric-aware where an index is present: a plain lexicographic sort puts `append-10` before
  // `append-2`, silently reordering injected prompt notes. Unreachable today (only two fragments are
  // ever produced) but the cost of being wrong later is a scrambled system prompt.
  const indexOf = (p: string): number => {
    const m = /-(\d+)\.md$/.exec(p);
    return m ? Number(m[1]) : Number.NaN;
  };
  const text = (prefix: string) =>
    entries
      .filter((e) => e.path.startsWith(prefix))
      .sort((a, b) => {
        const ia = indexOf(a.path);
        const ib = indexOf(b.path);
        if (!Number.isNaN(ia) && !Number.isNaN(ib) && ia !== ib) return ia - ib;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });

  return {
    digest,
    root,
    skillsDir: join(root, 'skills'),
    promptsDir: join(root, 'prompts'),
    context: text('context/').map((e) => ({ path: e.path, content: e.content.toString('utf8') })),
    promptFragments: text('prompt/').map((e) => e.content.toString('utf8')),
    entries,
  };
}

/**
 * Options that point pi at the bundle and suppress all discovery.
 *
 * `noSkills: true` still honours `additionalSkillPaths` — resource-loader.ts:405-407 merges them
 * in both branches — so this yields exactly the bundle's skills and nothing from the pod.
 *
 * `appendSystemPrompt` strings are passed as literal text. Note that pi's `resolvePromptInput`
 * (resource-loader.ts:49) reads a string as a FILE when `existsSync(input)`; our fragments are
 * multi-line prose, so they can never collide with a real path.
 */
export function buildLoaderOptions(promoted: PromotedConfig): PromotedLoaderOptions {
  return {
    additionalSkillPaths: [promoted.skillsDir],
    additionalPromptTemplatePaths: [promoted.promptsDir],
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    // Ignores `base` deliberately — see the leak regression test in test/config-resolver.test.ts.
    agentsFilesOverride: () => ({ agentsFiles: promoted.context }),
    appendSystemPrompt: promoted.promptFragments,
  };
}

/** Spread into the loader construction. Empty when nothing is promoted: behavior is unchanged. */
export function promotedLoaderOptions(
  promoted?: PromotedConfig,
): PromotedLoaderOptions | Record<string, never> {
  return promoted ? buildLoaderOptions(promoted) : {};
}

/** Fetch, verify and unpack. Throws (never degrades) on a missing or corrupt bundle. */
export async function resolvePromotedConfig(
  redis: BundleRedisLike,
  digest: string,
  baseDir: string = DEFAULT_CONFIG_BASE_DIR,
): Promise<PromotedConfig> {
  return unpackBundle(await getBundle(redis, digest), digest, baseDir);
}
