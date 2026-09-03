import { describe, it, expect } from 'vitest';
import { toolNameMappingNote, skillsRootNote, SKILLS_DIR_ENV } from '../src/notes.js';

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
  it('names the sandbox skills root and tells the model to resolve against it', () => {
    const note = skillsRootNote();
    expect(note).toContain(`$${SKILLS_DIR_ENV}`);
    expect(note.toLowerCase()).toContain('relative');
  });
  it('is multi-line', () => {
    expect(skillsRootNote()).toContain('\n');
  });
});
