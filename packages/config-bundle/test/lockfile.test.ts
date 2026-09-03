import { describe, it, expect } from 'vitest';
import { buildLockfile, serializeLockfile, skillContentHash } from '../src/lockfile.js';
import { BUNDLE_FORMAT_VERSION } from '../src/types.js';
import type { ResolvedSkill, LockfileInput } from '../src/types.js';

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

const inputWithMultipleUnsorted = () => ({
  digest: 'sha256:' + 'a'.repeat(64),
  mode: 'unattended' as const,
  entry: 'brainstorm-and-plan',
  classification: {
    travels: [skill('zulu'), skill('alpha')],
    dropped: [
      {
        name: 'zebra-skill',
        reason: 'no_harness_equivalent' as const,
        detail: 'detail1',
      },
      {
        name: 'alpha-skill',
        reason: 'needs_subagent' as const,
        detail: 'detail2',
      },
    ],
    interactionDependent: ['zulu-dep', 'alpha-dep'],
  },
  contextPaths: ['context/z.md', 'context/a.md'],
  memoryPaths: ['memory/z.md', 'memory/a.md'],
  sandboxImage: 'sandbox:pool-default',
  binaries: ['kubectl', 'gh'],
  versions: { pi: '0.42.0', harness: '0.0.0' },
  skillHashes: { zulu: 'sha256:' + 'z'.repeat(64), alpha: 'sha256:' + 'a'.repeat(64) },
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

  it('sorts every array field — binaries, context, memory, interactionDependent, dropped, skills', () => {
    const l = buildLockfile(inputWithMultipleUnsorted());
    expect(l.binaries).toEqual(['gh', 'kubectl']);
    expect(l.context).toEqual(['context/a.md', 'context/z.md']);
    expect(l.memory).toEqual(['memory/a.md', 'memory/z.md']);
    expect(l.interactionDependent).toEqual(['alpha-dep', 'zulu-dep']);
    expect(l.dropped.map((d) => d.name)).toEqual(['alpha-skill', 'zebra-skill']);
    expect(l.skills.map((s) => s.name)).toEqual(['alpha', 'zulu']);
  });

  it('uses an empty string when a skill has no content hash', () => {
    const inp = inputWithMultipleUnsorted();
    const partial = inp as Omit<LockfileInput, 'skillHashes'> & {
      skillHashes: Record<string, string>;
    };
    partial.skillHashes = {}; // Missing entries for both skills
    const l = buildLockfile(inp);
    expect(l.skills[0]!.contentHash).toBe('');
    expect(l.skills[1]!.contentHash).toBe('');
  });
});

describe('serializeLockfile', () => {
  it('is stable, sorted-key JSON with a trailing newline so it diffs legibly', () => {
    const a = serializeLockfile(buildLockfile(input()));
    const b = serializeLockfile(buildLockfile(input()));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    const obj = JSON.parse(a);
    const keys = Object.keys(obj);
    expect(keys).toEqual([...keys].sort());
  });

  it('recursively sorts keys at all nesting levels, not just top-level', () => {
    const serialized = serializeLockfile(buildLockfile(inputWithMultipleUnsorted()));
    const obj = JSON.parse(serialized);

    // Top-level keys must be sorted
    const topKeys = Object.keys(obj);
    expect(topKeys).toEqual([...topKeys].sort());

    // Nested object keys in skills[0] must be sorted
    // skills are built with {name, scope, sourceDir, contentHash} but should serialize as
    // {contentHash, name, scope, sourceDir} (alphabetical)
    const skillKeys = Object.keys(obj.skills[0]);
    expect(skillKeys).toEqual([...skillKeys].sort());
    expect(skillKeys).toEqual(['contentHash', 'name', 'scope', 'sourceDir']);

    // Nested object keys in dropped[0] must be sorted
    // dropped are built with {name, reason, detail} but should serialize as
    // {detail, name, reason} (alphabetical)
    const droppedKeys = Object.keys(obj.dropped[0]);
    expect(droppedKeys).toEqual([...droppedKeys].sort());
    expect(droppedKeys).toEqual(['detail', 'name', 'reason']);
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
