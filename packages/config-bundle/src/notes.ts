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
 *
 * This note deliberately names no environment variable. The bundle is content-addressed and
 * built once, before any leaf or sandbox exists, so it cannot bake in an absolute path — and no
 * seam exists to set an env var inside the sandbox for a tool call to read (every call is an
 * independent `bash -c`; see run-leaf.ts's overlay fragment for the mechanism that actually
 * carries the absolute paths). The concrete "Skill files: …" / "Memory files: …" paths are
 * appended per leaf, later in this same prompt — this note only tells the model to use those,
 * not the working directory.
 *
 * MUST stay multi-line, same reason as toolNameMappingNote above.
 */
export function skillsRootNote(): string {
  return [
    '## Where skill files live',
    '',
    'Elsewhere in this prompt, look for lines starting "Skill files:" and "Memory files:" —',
    'those name the absolute sandbox directories for this session.',
    '',
    'When a skill instructs you to read one of its own files by a path relative to the skill,',
    'resolve that path against the skill\'s own subdirectory under the "Skill files:" directory',
    '— not against the current working directory.',
  ].join('\n');
}
