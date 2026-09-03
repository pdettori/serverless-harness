import type { Classification, ClassifyOptions, DroppedSkill, ResolvedSkill } from './types.js';

/**
 * Skills whose subject matter does not exist in the harness. CURATED BY HAND and versioned
 * with this file — deliberately not inferred (spec §4.2). Heuristic detection was rejected
 * because the signal words ("agent", "artifact") appear in unrelated prose, and a
 * wrongly-dropped skill fails remotely and confusingly.
 */
export const DEFAULT_DENY_LIST: string[] = [
  'artifact-design',
  'artifact-diagramming',
  'document-skills:docx',
  'document-skills:pdf',
  'document-skills:pptx',
  'document-skills:xlsx',
  'fewer-permission-prompts',
  'keybindings-help',
  'statusline-setup',
  'update-config',
];

/** Skills whose operation IS dispatching subagents. Pi has no Task tool (spec §9). */
export const SUBAGENT_DEPENDENT: string[] = [
  'superpowers:dispatching-parallel-agents',
  'superpowers:subagent-driven-development',
];

/** Travels fine, but its method is dialogue — degrades to invented answers unattended. */
export const INTERACTION_DEPENDENT: string[] = [
  'superpowers:brainstorming',
  'superpowers:receiving-code-review',
];

/** Never reported as a missing binary. */
const SHELL_BUILTINS = new Set([
  'cd',
  'echo',
  'export',
  'set',
  'if',
  'then',
  'else',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'return',
  'exit',
  'source',
  'eval',
  'test',
  'true',
  'false',
  'read',
  'local',
  'shift',
  'trap',
  'unset',
  'printf',
  'wait',
  'exec',
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
 * Commands invoked inside fenced bash/sh blocks, as a *detection* signal for preflight.
 * Never installs anything; the sandbox image provides (spec §4.5).
 */
export function detectBinaries(skills: ResolvedSkill[]): string[] {
  const found = new Set<string>();
  for (const skill of skills) {
    for (const block of skill.skillMd.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
      for (const rawLine of block[1]!.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        for (const segment of line.split(/&&|\|\||[|;]/)) {
          const word = segment.trim().split(/\s+/)[0];
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
