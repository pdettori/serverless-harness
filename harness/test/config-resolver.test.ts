import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalTar, contentDigest } from '@sh/config-bundle';
import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { unpackBundle, buildLoaderOptions, promotedLoaderOptions } from '../src/config-resolver.js';

let base: string;

const bundle = () => {
  const entries = [
    {
      path: 'skills/keeper/SKILL.md',
      content: Buffer.from('---\nname: keeper\ndescription: d\n---\nbody'),
    },
    { path: 'skills/keeper/references/g.md', content: Buffer.from('guide') },
    { path: 'prompts/go.md', content: Buffer.from('do it') },
    { path: 'context/agents/0-CLAUDE.md', content: Buffer.from('# promoted project rules') },
    { path: 'context/MEMORY.md', content: Buffer.from('- [A](alpha.md)') },
    { path: 'memory/alpha.md', content: Buffer.from('fact') },
    { path: 'prompt/append-0.md', content: Buffer.from('note zero\nsecond line') },
    { path: 'prompt/append-1.md', content: Buffer.from('note one\nsecond line') },
  ];
  return { tar: canonicalTar(entries), digest: contentDigest(entries) };
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sh-config-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('unpackBundle', () => {
  it('materializes skills and prompts as real files (pi reads skill bodies from disk)', () => {
    const { tar, digest } = bundle();
    const p = unpackBundle(tar, digest, base);
    expect(existsSync(join(p.skillsDir, 'keeper', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(p.skillsDir, 'keeper', 'references', 'g.md'), 'utf8')).toBe('guide');
    expect(existsSync(join(p.promptsDir, 'go.md'))).toBe(true);
  });

  it('returns context inline, ordered, without writing it to disk', () => {
    const { tar, digest } = bundle();
    const p = unpackBundle(tar, digest, base);
    expect(p.context.map((c) => c.path)).toEqual([
      'context/MEMORY.md',
      'context/agents/0-CLAUDE.md',
    ]);
    expect(p.context.find((c) => c.path.endsWith('0-CLAUDE.md'))!.content).toContain('promoted');
  });

  it('returns prompt fragments in append-N order', () => {
    const { tar, digest } = bundle();
    expect(unpackBundle(tar, digest, base).promptFragments[0]).toContain('note zero');
    expect(unpackBundle(tar, digest, base).promptFragments[1]).toContain('note one');
  });

  it('is idempotent and leaves no temp directory behind', () => {
    const { tar, digest } = bundle();
    unpackBundle(tar, digest, base);
    unpackBundle(tar, digest, base);
    expect(readdirSync(base).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('names the directory after the digest so the cache can never be stale', () => {
    const { tar, digest } = bundle();
    expect(unpackBundle(tar, digest, base).root).toBe(join(base, digest.replace(':', '-')));
  });

  it('rejects an entry path that escapes the unpack root', () => {
    const evil = canonicalTar([{ path: '../escape.md', content: Buffer.from('x') }]);
    expect(() => unpackBundle(evil, 'sha256:' + '0'.repeat(64), base)).toThrow(/escapes/);
  });
});

describe('buildLoaderOptions', () => {
  const { tar, digest } = bundle();

  it('points pi at the bundle and suppresses discovery', () => {
    const o = buildLoaderOptions(unpackBundle(tar, digest, base));
    expect(o.additionalSkillPaths).toHaveLength(1);
    expect(o.noContextFiles).toBe(true);
    expect(o.noSkills).toBe(true);
    expect(o.noPromptTemplates).toBe(true);
  });

  it('supplies context through agentsFilesOverride, ignoring the base entirely', () => {
    const o = buildLoaderOptions(unpackBundle(tar, digest, base));
    const out = o.agentsFilesOverride({
      agentsFiles: [{ path: '/leak/CLAUDE.md', content: 'leak' }],
    });
    expect(out.agentsFiles.map((f) => f.path)).not.toContain('/leak/CLAUDE.md');
  });
});

describe('promotedLoaderOptions', () => {
  it('is EMPTY when no bundle is promoted — this is the unchanged-behavior guarantee', () => {
    expect(Object.keys(promotedLoaderOptions(undefined))).toEqual([]);
  });
});

// REGRESSION TEST — do not delete. The harness CLAUDE.md leak.
//
// loadProjectContextFiles (pi-fork resource-loader.ts:62) walks ancestor directories for
// CLAUDE.md/AGENTS.md. Run inside this repository, that walk reaches OUR OWN CLAUDE.md
// ("Serverless Harness ... pnpm workspace ... DCO sign-off required"). Unsuppressed, every
// promoted session would silently inherit the harness project's instructions as if they were
// the user's. It fails as plausible-but-wrong behavior, never as an error, so nothing else
// would catch it.
//
// TWO mechanisms close it and both are deliberate: agentsFilesOverride ignores the base, and
// noContextFiles makes the base empty. The override alone is sufficient TODAY — but a
// natural-looking future edit to `(base) => ({agentsFiles: [...base.agentsFiles, ...ours]})`
// would reopen the leak, and noContextFiles keeps it shut even then.
describe('harness CLAUDE.md leak', () => {
  it('never exposes the harness project CLAUDE.md to a promoted session', async () => {
    const { tar, digest } = bundle();
    const promoted = unpackBundle(tar, digest, base);
    const repoRoot = resolve(__dirname, '..', '..');
    expect(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')).toContain('Serverless Harness');

    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: getAgentDir(),
      ...buildLoaderOptions(promoted),
    });
    await loader.reload();

    const files = loader.getAgentsFiles().agentsFiles;
    expect(files.some((f) => f.content.includes('Serverless Harness'))).toBe(false);
    expect(files.some((f) => f.content.includes('promoted project rules'))).toBe(true);
  });

  it('loads exactly the bundle skills and nothing discovered', async () => {
    const { tar, digest } = bundle();
    const loader = new DefaultResourceLoader({
      cwd: resolve(__dirname, '..', '..'),
      agentDir: getAgentDir(),
      ...buildLoaderOptions(unpackBundle(tar, digest, base)),
    });
    await loader.reload();
    // Pins the semantics found at resource-loader.ts:405-407: noSkills still honours
    // additionalSkillPaths, so this yields the bundle's skills only.
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(['keeper']);
  });
});
