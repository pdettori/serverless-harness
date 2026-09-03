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

  it('warns when a sibling under a directory the skill owns is absent', () => {
    // The skill ships references/guide.md, so it demonstrably owns references/ — a missing file
    // there is a real packaging gap. Warn, not error: preflight blocks only on facts.
    const s = skill('x', 'see `references/missing.md` for detail', ['references/guide.md']);
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.code).toBe('missing_sibling');
    expect(f[0]!.message).toContain('references/missing.md');
  });

  it('ignores paths the skill does not own, which is what prose is full of', () => {
    // Measured: without these two exclusions the check fired 182 times across 28 real skills.
    const bare = skill('x', 'create `main.py` and `requirements.txt` yourself', [
      'references/g.md',
    ]);
    expect(checkSiblingPaths([bare])).toEqual([]);
    const unowned = skill('y', 'see `src/server.ts` in your project', ['references/g.md']);
    expect(checkSiblingPaths([unowned])).toEqual([]);
    const code = skill('z', 'call `window.open` and read `sys.path`', ['references/g.md']);
    expect(checkSiblingPaths([code])).toEqual([]);
  });

  it('ignores URLs and non-file-looking backticks', () => {
    const s = skill('x', 'see `https://e.com/a.md` and `--flag` and `some text`', []);
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('ignores version numbers, IPs, semver ranges, and globs', () => {
    const s = skill(
      'x',
      'see `1.2.3` and `127.0.0.1` and `node>=18.0` and `*.md` in backticks',
      [],
    );
    expect(checkSiblingPaths([s])).toEqual([]);
  });

  it('still warns on genuinely missing owned files when filtering out false positives', () => {
    // The skill owns references/ (it ships references/guide.md), so references/missing.md is a
    // real gap even alongside version numbers and IPs that must NOT be mistaken for paths.
    const s = skill(
      'x',
      'see `1.2.3` version and `references/missing.md` file and `127.0.0.1` IP',
      ['references/guide.md'],
    );
    const f = checkSiblingPaths([s]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('references/missing.md');
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

  it('handles markdown links [Title](file.md) when file is present', () => {
    expect(checkMemoryLinks('- [Alpha](alpha.md) — reference', ['alpha.md'])).toEqual([]);
  });

  it('warns for dangling markdown links', () => {
    const f = checkMemoryLinks('- [Missing](alpha.md)', ['beta.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('handles wikilinks with |alias suffix', () => {
    expect(checkMemoryLinks('see [[alpha|Alpha Notes]] in the docs', ['alpha.md'])).toEqual([]);
  });

  it('handles wikilinks with path prefix', () => {
    expect(
      checkMemoryLinks('see [[notes/alpha]] and [[beta]] in memory', ['alpha.md', 'beta.md']),
    ).toEqual([]);
  });

  it('mixes markdown and wikilinks', () => {
    const index = '- [Alpha](alpha.md)\n- [[beta|Beta Title]]\n- [[notes/gamma]]';
    expect(checkMemoryLinks(index, ['alpha.md', 'beta.md', 'gamma.md'])).toEqual([]);
  });

  it('warns for any dangling form in a mixed index', () => {
    const index = '- [Alpha](alpha.md)\n- [[gone]]';
    const f = checkMemoryLinks(index, ['alpha.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('gone');
  });

  it('ignores external URLs in markdown links', () => {
    expect(checkMemoryLinks('[doc](https://example.com/file.md)', [])).toEqual([]);
  });

  it('ignores relative paths outside memory in markdown links', () => {
    expect(checkMemoryLinks('[x](../elsewhere/x.md)', ['alpha.md'])).toEqual([]);
  });

  it('still catches dangling local markdown links after filtering non-local', () => {
    // Present: should be quiet
    expect(checkMemoryLinks('[t](alpha.md)', ['alpha.md'])).toEqual([]);
    // Absent: should warn
    const f = checkMemoryLinks('[t](alpha.md)', ['beta.md']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('dangling_memory_link');
  });

  it('ignores wikilinks with .. path segments', () => {
    expect(checkMemoryLinks('see [[../outside/x]] in backlinks', ['alpha.md'])).toEqual([]);
  });
});

describe('checkBinaries', () => {
  it('warns, and never errors, for a binary absent from the sandbox inventory', () => {
    const f = checkBinaries(['gh', 'kubectl'], ['kubectl']);
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('missing_binary');
    expect(f[0]!.severity).toBe('warn');
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
