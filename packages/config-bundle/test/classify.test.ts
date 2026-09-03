import { describe, it, expect } from 'vitest';
import {
  classifySkills,
  detectBinaries,
  DEFAULT_DENY_LIST,
  INTERACTION_DEPENDENT,
  SUBAGENT_DEPENDENT,
} from '../src/classify.js';
import type { ResolvedSkill } from '../src/types.js';

const s = (name: string, body = 'body'): ResolvedSkill => ({
  name,
  dir: `/tmp/${name}`,
  skillMd: `---\nname: ${name}\ndescription: d\n---\n${body}`,
  files: ['SKILL.md'],
  scope: 'plugin',
});

describe('classifySkills', () => {
  it('lets an ordinary prose skill travel', () => {
    const c = classifySkills([s('brainstorming'), s('my-skill')], {
      mode: 'attended',
    });
    expect(c.travels.map((x) => x.name)).toContain('my-skill');
    expect(c.dropped).toEqual([]);
  });

  it('drops deny-listed families with no_harness_equivalent', () => {
    const c = classifySkills([s('xlsx'), s('artifact-design')], {
      mode: 'unattended',
    });
    expect(c.travels).toEqual([]);
    expect(c.dropped.map((d) => d.reason)).toEqual([
      'no_harness_equivalent',
      'no_harness_equivalent',
    ]);
  });

  it('drops subagent-dependent skills with needs_subagent (spec §9, out of scope)', () => {
    const c = classifySkills([s('dispatching-parallel-agents')], {
      mode: 'unattended',
    });
    expect(c.dropped[0]!.reason).toBe('needs_subagent');
  });

  it('does NOT drop a skill merely for containing the word agent', () => {
    // The curated-not-inferred rule: "agent" appears in nearly every superpowers skill.
    const c = classifySkills([s('some-skill', 'dispatch an agent-like helper')], {
      mode: 'unattended',
    });
    expect(c.travels.map((x) => x.name)).toEqual(['some-skill']);
  });

  it('honours a user deny-list additively', () => {
    const c = classifySkills([s('private-thing'), s('keeper')], {
      mode: 'attended',
      userDenyList: ['private-thing'],
    });
    expect(c.dropped[0]).toEqual({
      name: 'private-thing',
      reason: 'user_denied',
      detail: 'excluded by the local user deny-list',
    });
    expect(c.travels.map((x) => x.name)).toEqual(['keeper']);
  });

  it('flags interaction-dependent skills without dropping them, under unattended', () => {
    const c = classifySkills([s('brainstorming')], { mode: 'unattended' });
    expect(c.interactionDependent).toEqual(['brainstorming']);
    expect(c.travels.map((x) => x.name)).toEqual(['brainstorming']);
  });

  it('does not flag interaction dependence under attended mode', () => {
    const c = classifySkills([s('brainstorming')], { mode: 'attended' });
    expect(c.interactionDependent).toEqual([]);
  });

  it('lists deny-list and interaction-list entries as plain data, not regexes', () => {
    expect(DEFAULT_DENY_LIST.every((n) => typeof n === 'string')).toBe(true);
    expect(INTERACTION_DEPENDENT).toContain('brainstorming');
  });

  it('uses bare name form from SKILL.md frontmatter, never qualified scope:name', () => {
    // All three curated lists must contain no `:` character; they are matched against
    // ResolvedSkill.name which is the bare frontmatter name, not scope-qualified.
    const allEntries = [...DEFAULT_DENY_LIST, ...SUBAGENT_DEPENDENT, ...INTERACTION_DEPENDENT];
    expect(allEntries.every((e) => !e.includes(':'))).toBe(true);
  });

  it('drops subagent-dependent skills by bare name', () => {
    const c = classifySkills([s('dispatching-parallel-agents')], {
      mode: 'unattended',
    });
    expect(c.dropped[0]).toEqual({
      name: 'dispatching-parallel-agents',
      reason: 'needs_subagent',
      detail: 'requires a subagent tool; Pi has none (spec §9)',
    });
    expect(c.travels).toEqual([]);
  });

  it('drops all subagent-dependent skills by bare name', () => {
    const c = classifySkills([s('subagent-driven-development')], {
      mode: 'unattended',
    });
    expect(c.dropped[0]!.reason).toBe('needs_subagent');
  });

  it('flags interaction-dependent skills by bare name, unattended', () => {
    const c = classifySkills([s('brainstorming')], { mode: 'unattended' });
    expect(c.interactionDependent).toEqual(['brainstorming']);
    expect(c.travels.map((x) => x.name)).toEqual(['brainstorming']);
  });

  it('drops deny-listed skills by bare name', () => {
    const c = classifySkills([s('xlsx')], { mode: 'unattended' });
    expect(c.dropped[0]).toEqual({
      name: 'xlsx',
      reason: 'no_harness_equivalent',
      detail: 'subject matter does not exist in the harness runtime',
    });
  });
});

describe('detectBinaries', () => {
  it('finds commands in fenced bash blocks', () => {
    const skill = s('x', '```bash\ngh pr list\nkubectl get pods\n```');
    expect(detectBinaries([skill])).toEqual(['gh', 'kubectl']);
  });

  it('ignores shell builtins and flags', () => {
    const skill = s('x', '```bash\ncd /tmp && echo hi\nexport A=1\n```');
    expect(detectBinaries([skill])).toEqual([]);
  });

  it('deduplicates and sorts', () => {
    const a = s('a', '```bash\ngh x\n```');
    const b = s('b', '```bash\ngh y\npnpm i\n```');
    expect(detectBinaries([a, b])).toEqual(['gh', 'pnpm']);
  });

  it('skips leading environment variable assignments', () => {
    const skill = s('x', '```bash\nSH_PROMOTE_LIVE_SMOKE=1 pnpm exec vitest run\n```');
    expect(detectBinaries([skill])).toEqual(['pnpm']);
  });

  it('ignores non-shell fenced blocks but finds commands in adjacent bash blocks', () => {
    const skill = s(
      'x',
      '```ts\ngh pr list\n```\n```\necho hi\n```\n```bash\nkubectl get pods\n```',
    );
    expect(detectBinaries([skill])).toEqual(['kubectl']);
  });
});
