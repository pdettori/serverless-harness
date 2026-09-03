export const SKILLS_DIR_ENV = 'SH_SKILLS_DIR';
export const MEMORY_DIR_ENV = 'SH_MEMORY_DIR';

/**
 * Injected via appendSystemPrompt instead of rewriting 149 skill files (spec D4, A1). A regex
 * deciding whether "Read" is a tool reference or English will occasionally mangle a sentence,
 * and the damage only shows up as a skill misbehaving remotely.
 *
 * MUST stay multi-line: pi-fork `resource-loader.ts:49` treats an appendSystemPrompt string as
 * a FILE PATH when `existsSync(input)` is true, and only falls back to literal text otherwise.
 */
export function toolNameMappingNote(): string {
  return [
    '## Tool names in skills',
    '',
    'Skill instructions in this session were authored for Claude Code and may name its tools.',
    'The equivalents available here are:',
    '',
    '- `Bash` → `bash`',
    '- `Read` → `read`',
    '- `Write` → `write`',
    '- `Edit` → `edit`',
    '- `Grep` → `grep`',
    '- `Glob` → `find`',
    '- `LS` → `ls`',
    '',
    'Treat a skill naming the left-hand tool as naming the right-hand one. Tools with no',
    'equivalent here (subagent dispatch, artifacts, document generation) are unavailable: if a',
    'skill requires one, say so rather than simulating it.',
  ].join('\n');
}

/**
 * Path translation (spec §4.5). A skill's SKILL.md is read in the harness pod, but its internal
 * paths were written relative to where the skill lives locally — e.g. superpowers:brainstorming
 * instructs a read of `skills/brainstorming/visual-companion.md`. Tool calls execute in the
 * sandbox, so without this note that read resolves to nothing and the model gets a confusing
 * miss rather than an actionable error.
 */
export function skillsRootNote(): string {
  return [
    '## Where skill files live',
    '',
    `Skill directories are available in the sandbox at \`$${SKILLS_DIR_ENV}/<skill-name>/\`, and`,
    `memory files at \`$${MEMORY_DIR_ENV}/\`.`,
    '',
    'When a skill instructs you to read one of its own files, resolve that relative path against',
    `\`$${SKILLS_DIR_ENV}/<skill-name>/\` — not against the current working directory.`,
  ].join('\n');
}
