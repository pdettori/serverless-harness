import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkills, readSkillFrontmatterName } from '../src/resolve.js';

let root: string;

function skill(dir: string, name: string, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does ${name}\n---\n\nbody of ${name}\n`,
  );
  for (const [rel, body] of Object.entries(extra)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-resolve-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readSkillFrontmatterName', () => {
  it('reads the frontmatter name', () => {
    expect(readSkillFrontmatterName('---\nname: foo\n---\nbody')).toBe('foo');
  });
  it('returns null when there is no frontmatter', () => {
    expect(readSkillFrontmatterName('# just a heading')).toBeNull();
  });
  it('strips surrounding double quotes', () => {
    expect(readSkillFrontmatterName('---\nname: "foo"\n---\nbody')).toBe('foo');
  });
  it('strips surrounding single quotes', () => {
    expect(readSkillFrontmatterName("---\nname: 'foo'\n---\nbody")).toBe('foo');
  });
  it('leaves unquoted names untouched', () => {
    expect(readSkillFrontmatterName('---\nname: foo\n---\nbody')).toBe('foo');
  });
});

describe('resolveSkills', () => {
  it('finds a skill by its SKILL.md and records its sibling files', () => {
    skill(join(root, 'user', 'skills', 'alpha'), 'alpha', {
      'references/guide.md': 'g',
      'run.sh': '#!/bin/sh\n',
    });
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('alpha');
    expect(found[0]!.scope).toBe('user');
    expect(found[0]!.files.sort()).toEqual(['SKILL.md', 'references/guide.md', 'run.sh']);
  });

  it('dedupes the same skill appearing in plugins/cache and plugins/marketplaces', () => {
    skill(join(root, 'plugins', 'marketplaces', 'mp', 'skills', 'dup'), 'dup');
    skill(join(root, 'plugins', 'cache', 'mp', 'skills', 'dup'), 'dup');
    const found = resolveSkills({ pluginDirs: [join(root, 'plugins')] });
    expect(found.map((s) => s.name)).toEqual(['dup']);
  });

  it('prefers project scope over user scope for the same name', () => {
    skill(join(root, 'user', 'skills', 'both'), 'both');
    skill(join(root, 'proj', 'skills', 'both'), 'both');
    const found = resolveSkills({
      projectDir: join(root, 'proj'),
      userDir: join(root, 'user'),
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.scope).toBe('project');
  });

  it('does not recurse below a directory that already holds a SKILL.md', () => {
    skill(join(root, 'user', 'skills', 'outer'), 'outer');
    skill(join(root, 'user', 'skills', 'outer', 'nested'), 'nested');
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found.map((s) => s.name)).toEqual(['outer']);
    // the nested SKILL.md is carried as a plain file of `outer`, not as its own skill
    expect(found[0]!.files).toContain('nested/SKILL.md');
  });

  it('falls back to the directory name when frontmatter has no name', () => {
    const dir = join(root, 'user', 'skills', 'unnamed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here');
    expect(resolveSkills({ userDir: join(root, 'user') })[0]!.name).toBe('unnamed');
  });

  it('returns an empty list for roots that do not exist', () => {
    expect(resolveSkills({ userDir: join(root, 'nope') })).toEqual([]);
  });

  it('skips dangling symlinks without throwing', () => {
    skill(join(root, 'user', 'skills', 'real'), 'real');
    // Create a dangling symlink inside the skill directory
    const skillDir = join(root, 'user', 'skills', 'real');
    symlinkSync(join(root, 'nonexistent'), join(skillDir, 'dangling'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('real');
    // dangling symlink should not appear in files
    expect(found[0]!.files).not.toContain('dangling');
  });

  it('does not hang on symlink cycles', () => {
    skill(join(root, 'user', 'skills', 'real'), 'real');
    const skillDir = join(root, 'user', 'skills', 'real');
    const subdir = join(skillDir, 'subdir');
    mkdirSync(subdir);
    // Create a symlink cycle: subdir -> skill dir (ancestor)
    symlinkSync(skillDir, join(subdir, 'cycle'));
    const found = resolveSkills({ userDir: join(root, 'user') });
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('real');
  });
});
