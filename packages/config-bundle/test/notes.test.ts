import { describe, it, expect } from 'vitest';
import { toolNameMappingNote, skillsRootNote } from '../src/notes.js';

describe('toolNameMappingNote', () => {
  const note = toolNameMappingNote();
  it('maps every Claude Code built-in that differs from Pi', () => {
    for (const pair of ['Bash', 'bash', 'Glob', 'find', 'LS', 'ls', 'Read', 'read']) {
      expect(note).toContain(pair);
    }
  });
  it('is multi-line, so resolvePromptInput cannot mistake it for a file path', () => {
    // pi-fork resource-loader.ts:49 reads the string as a FILE when existsSync(input).
    expect(note).toContain('\n');
  });
});

describe('skillsRootNote', () => {
  it('does not name an environment variable -- nothing in this system ever sets one', () => {
    const note = skillsRootNote();
    // The bug this test guards: the note used to instruct the model to use $SH_SKILLS_DIR /
    // $SH_MEMORY_DIR, which no seam (bundle build time, or the sandbox's per-call `bash -c`)
    // can ever set. Following that instruction literally expands to nothing and misses.
    expect(note).not.toContain('SH_SKILLS_DIR');
    expect(note).not.toContain('SH_MEMORY_DIR');
    expect(note).not.toContain('$');
  });

  it("tells the model to resolve a skill's relative file references against that skill's own directory, not cwd", () => {
    const note = skillsRootNote().toLowerCase();
    expect(note).toContain('relative');
    expect(note).toContain('skill');
    expect(note).toContain('working directory');
  });

  it('points at the "Skill files:" / "Memory files:" fragment run-leaf.ts injects per leaf', () => {
    // This is the load-bearing link to run-leaf.ts's self-describing fragment: the note alone
    // cannot carry an absolute path (the bundle is built once, before any leaf exists), so it
    // must point at where that path actually appears in the prompt.
    const note = skillsRootNote();
    expect(note).toContain('Skill files:');
    expect(note).toContain('Memory files:');
  });

  it('is multi-line, so resolvePromptInput cannot mistake it for a file path', () => {
    expect(skillsRootNote()).toContain('\n');
  });
});
