/** One file in a bundle. `mode` defaults to 0o644; scripts use 0o755. */
export interface TarEntry {
  path: string;
  content: Buffer;
  mode?: number;
}

/** Bundle wire-format version. Bumped only on a breaking layout change. */
export const BUNDLE_FORMAT_VERSION = 1;

export type SkillScope = 'project' | 'user' | 'plugin';

/** One skill, resolved to a directory. `files` are paths relative to `dir`, always incl. SKILL.md. */
export interface ResolvedSkill {
  name: string;
  dir: string;
  skillMd: string;
  files: string[];
  scope: SkillScope;
}

export interface SkillRoots {
  /** Repo-local `.claude` directory. */
  projectDir?: string;
  /** `~/.claude`. */
  userDir?: string;
  /** e.g. [`~/.claude/plugins`]. Scanned recursively; cache/marketplace duplicates collapse. */
  pluginDirs?: string[];
}
