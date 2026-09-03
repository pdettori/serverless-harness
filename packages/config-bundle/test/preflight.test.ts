import { describe, it, expect } from 'vitest';
import {
  checkSiblingPaths,
  checkMemoryLinks,
  checkBinaries,
  checkEntry,
  checkInteraction,
  renderPreflight,
  hasErrors,
} from '../src/preflight.js';
import type { ResolvedSkill } from '../src/types.js';

const skill = (name: string, body: string, files: string[]): ResolvedSkill => ({
  name,
  dir: `/s/${name}`,
  skillMd: `---\nname: ${name}\n---\n${body}`,
  files: ['SKILL.md', ...files],
  scope: 'plugin',
});

describe('checkSiblingPaths', () => {
  it('is quiet when a referenced sibling is present', () => {
    const s = skill('brainstorming', 'read `skills/brainstorming/visual-companion.md`', [
      'visual-companion.md',
    ]);
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('errors when a referenced sibling is absent from the bundle', () => {
    const s = skill('x', 'see `references/missing.md` for detail', []);
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
    expect(f[0]!.code).toBe('missing_sibling');
    expect(f[0]!.message).toContain('references/missing.md');
  });

  it('ignores URLs and non-file-looking backticks', () => {
    const s = skill('x', 'see `https://e.com/a.md` and `--flag` and `some text`', []);
    expect(checkSiblingPaths([s])).toEqual([]);
  });
});

describe('checkMemoryLinks', () => {
  it('is quiet when every [[link]] resolves to an included memory file', () => {
    expect(checkMemoryLinks('see [[alpha]] and [[beta]]', ['alpha.md', 'beta.md'])).toEqual([]);
  });

  it('warns for a dangling link', () => {
    const f = checkMemoryLinks('see [[gone]]', ['alpha.md']);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('is quiet when there is no memory index at all', () => {
    expect(checkMemoryLinks(undefined, [])).toEqual([]);
  });
});

describe('checkBinaries', () => {
  it('errors for a binary absent from the sandbox inventory', () => {
    const f = checkBinaries(['gh', 'kubectl'], ['kubectl']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('missing_binary');
    expect(f[0]!.message).toContain('gh');
  });

  it('is quiet when every binary is present', () => {
    expect(checkBinaries(['gh'], ['gh', 'kubectl'])).toEqual([]);
  });

  it('warns (not errors) when no inventory is available to check against', () => {
    const f = checkBinaries(['gh'], undefined);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('inventory_unavailable');
  });
});

describe('checkEntry', () => {
  it('errors when the entry prompt is not in the bundle', () => {
    expect(checkEntry('nope', ['a', 'b'])[0]!.code).toBe('unknown_entry');
  });
  it('is quiet when it is', () => {
    expect(checkEntry('a', ['a'])).toEqual([]);
  });
});

describe('checkInteraction', () => {
  it('warns for each interaction-dependent skill', () => {
    const f = checkInteraction({
      travels: [],
      dropped: [],
      interactionDependent: ['superpowers:brainstorming'],
    });
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('interaction_dependent');
  });
});

describe('renderPreflight / hasErrors', () => {
  it('hasErrors is true only when a finding is an error', () => {
    expect(hasErrors([{ severity: 'warn', code: 'w', message: 'm' }])).toBe(false);
    expect(hasErrors([{ severity: 'error', code: 'e', message: 'm' }])).toBe(true);
  });

  it('renders findings grouped by severity, and states its own limits', () => {
    const out = renderPreflight([
      { severity: 'error', code: 'missing_binary', message: 'gh missing' },
      { severity: 'warn', code: 'interaction_dependent', message: 'brainstorming' },
    ]);
    expect(out).toContain('error');
    expect(out).toContain('gh missing');
    expect(out).toContain('warn');
    // The honesty requirement of spec §4.6: never imply completeness.
    expect(out.toLowerCase()).toContain('cannot be checked locally');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(renderPreflight([]).toLowerCase()).toContain('no findings');
  });
});
