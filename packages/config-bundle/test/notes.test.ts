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

  it('tells the model what to do when those lines are absent, instead of dangling', () => {
    // run-leaf.ts appends the "Skill files:"/"Memory files:" lines only when a sandbox is
    // selected. The bundle is built before any leaf exists, so this note cannot be omitted
    // conditionally -- without a fallback it points at lines that were never written, which is
    // the same "instruction referencing something absent" defect the env-var removal fixed.
    const note = skillsRootNote();
    expect(note).toMatch(/if no such lines appear/i);
    expect(note.toLowerCase()).toContain('not reachable');
    // Must tell the model to SAY so rather than invent a path or misreport a missing file.
    expect(note.toLowerCase()).toMatch(/say so/);
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
