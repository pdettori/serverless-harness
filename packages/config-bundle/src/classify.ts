import type { Classification, ClassifyOptions, DroppedSkill, ResolvedSkill } from './types.js';

/**
 * Skills whose subject matter does not exist in the harness. Matched against the bare
 * `name` field from SKILL.md frontmatter, not a qualified `plugin:name` form.
 * CURATED BY HAND and versioned with this file — deliberately not inferred (spec §4.2).
 * Heuristic detection was rejected because the signal words ("agent", "artifact") appear
 * in unrelated prose, and a wrongly-dropped skill fails remotely and confusingly.
 */
export const DEFAULT_DENY_LIST: readonly string[] = [
  // Real deny-list: skills on-disk whose subject matter doesn't exist in the harness.
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  // Defensive entries: built-in Claude Code skills. Retained in case a future version
  // ships them as SKILL.md files (so the next reader doesn't delete them as dead code).
  'artifact-design',
  'artifact-diagramming',
  'fewer-permission-prompts',
  'keybindings-help',
  'statusline-setup',
  'update-config',
];

/**
 * Skills whose operation IS dispatching subagents. Pi has no Task tool (spec §9).
 * Matched against the bare `name` field from SKILL.md frontmatter.
 */
export const SUBAGENT_DEPENDENT: readonly string[] = [
  'dispatching-parallel-agents',
  'subagent-driven-development',
];

/**
 * Travels fine, but its method is dialogue — degrades to invented answers unattended.
 * Matched against the bare `name` field from SKILL.md frontmatter.
 */
export const INTERACTION_DEPENDENT: readonly string[] = ['brainstorming', 'receiving-code-review'];

/** Never reported as a missing binary. Complete bash builtins and keywords. */
const SHELL_BUILTINS = new Set([
  ':',
  '.',
  'source',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'cd',
  'command',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'echo',
  'enable',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readarray',
  'readonly',
  'return',
  'select',
  'set',
  'shift',
  'shopt',
  'suspend',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'in',
  'time',
]);

export function classifySkills(skills: ResolvedSkill[], opts: ClassifyOptions): Classification {
  const denied = new Set(opts.userDenyList ?? []);
  const travels: ResolvedSkill[] = [];
  const dropped: DroppedSkill[] = [];

  for (const skill of skills) {
    if (denied.has(skill.name)) {
      dropped.push({
        name: skill.name,
        reason: 'user_denied',
        detail: 'excluded by the local user deny-list',
      });
    } else if (DEFAULT_DENY_LIST.includes(skill.name)) {
      dropped.push({
        name: skill.name,
        reason: 'no_harness_equivalent',
        detail: 'subject matter does not exist in the harness runtime',
      });
    } else if (SUBAGENT_DEPENDENT.includes(skill.name)) {
      dropped.push({
        name: skill.name,
        reason: 'needs_subagent',
        detail: 'requires a subagent tool; Pi has none (spec §9)',
      });
    } else {
      travels.push(skill);
    }
  }

  const interactionDependent =
    opts.mode === 'unattended'
      ? travels.filter((s) => INTERACTION_DEPENDENT.includes(s.name)).map((s) => s.name)
      : [];

  return { travels, dropped, interactionDependent };
}

/**
 * Commands invoked inside fenced bash/sh/shell blocks, as a *detection* signal for preflight.
 * Never installs anything; the sandbox image provides (spec §4.5).
 *
 * Parser is intentionally shell-naive: it does not understand quoting, so a `|` or `&&`
 * inside a quoted string can mis-split. This is an accepted limitation.
 */
export function detectBinaries(skills: ResolvedSkill[]): string[] {
  const found = new Set<string>();
  for (const skill of skills) {
    for (const block of skill.skillMd.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
      for (const rawLine of block[1]!.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        for (const segment of line.split(/&&|\|\||[|;]/)) {
          let trimmed = segment.trim();
          // Skip leading environment variable assignments (e.g. FOO=bar).
          trimmed = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
          const word = trimmed.split(/\s+/)[0];
          if (!word) continue;
          if (!/^[a-z][a-z0-9._-]*$/.test(word)) continue;
          if (SHELL_BUILTINS.has(word)) continue;
          found.add(word);
        }
      }
    }
  }
  return [...found].sort();
}
