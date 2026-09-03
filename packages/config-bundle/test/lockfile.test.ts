import { describe, it, expect } from 'vitest';
import { buildLockfile, serializeLockfile, skillContentHash } from '../src/lockfile.js';
import { BUNDLE_FORMAT_VERSION } from '../src/types.js';
import type { ResolvedSkill } from '../src/types.js';

const skill = (name: string): ResolvedSkill => ({
  name,
  dir: `/home/u/.claude/skills/${name}`,
  skillMd: `---\nname: ${name}\n---\nbody`,
  files: ['SKILL.md'],
  scope: 'user',
});

const input = () => ({
  digest: 'sha256:' + 'a'.repeat(64),
  mode: 'unattended' as const,
  entry: 'brainstorm-and-plan',
  classification: {
    travels: [skill('keeper')],
    dropped: [
      {
        name: 'artifact-design',
        reason: 'no_harness_equivalent' as const,
        detail: 'subject matter does not exist in the harness runtime',
      },
    ],
    interactionDependent: ['superpowers:brainstorming'],
  },
  contextPaths: ['context/agents/0-CLAUDE.md'],
  memoryPaths: ['memory/ghcr-images-moved-to-rossoctl.md'],
  sandboxImage: 'sandbox:pool-default',
  binaries: ['gh', 'kubectl'],
  versions: { pi: '0.42.0', harness: '0.0.0' },
  skillHashes: { keeper: 'sha256:' + 'b'.repeat(64) },
});

describe('buildLockfile', () => {
  it('stamps the format version and the digest', () => {
    const l = buildLockfile(input());
    expect(l.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(l.digest).toBe('sha256:' + 'a'.repeat(64));
  });

  it('records every included skill with its source dir and content hash', () => {
    const l = buildLockfile(input());
    expect(l.skills).toEqual([
      {
        name: 'keeper',
        scope: 'user',
        sourceDir: '/home/u/.claude/skills/keeper',
        contentHash: 'sha256:' + 'b'.repeat(64),
      },
    ]);
  });

  it('records every exclusion with a machine-readable reason', () => {
    expect(buildLockfile(input()).dropped[0]!.reason).toBe('no_harness_equivalent');
  });

  it('records interaction-dependent skills, context, memory, image and binaries', () => {
    const l = buildLockfile(input());
    expect(l.interactionDependent).toEqual(['superpowers:brainstorming']);
    expect(l.context).toEqual(['context/agents/0-CLAUDE.md']);
    expect(l.memory).toEqual(['memory/ghcr-images-moved-to-rossoctl.md']);
    expect(l.sandboxImage).toBe('sandbox:pool-default');
    expect(l.binaries).toEqual(['gh', 'kubectl']);
  });
});

describe('serializeLockfile', () => {
  it('is stable, sorted-key JSON with a trailing newline so it diffs legibly', () => {
    const a = serializeLockfile(buildLockfile(input()));
    const b = serializeLockfile(buildLockfile(input()));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    const keys = Object.keys(JSON.parse(a));
    expect(keys).toEqual([...keys].sort());
  });
});

describe('skillContentHash', () => {
  it('is stable for identical content and differs when a file changes', () => {
    const s = skill('x');
    const one = skillContentHash(s, [{ path: 'skills/x/SKILL.md', content: Buffer.from('a') }]);
    const same = skillContentHash(s, [{ path: 'skills/x/SKILL.md', content: Buffer.from('a') }]);
    const other = skillContentHash(s, [{ path: 'skills/x/SKILL.md', content: Buffer.from('b') }]);
    expect(one).toBe(same);
    expect(one).not.toBe(other);
  });
});
