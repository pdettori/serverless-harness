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

export type DropReason = 'no_harness_equivalent' | 'needs_subagent' | 'user_denied';

/** Unattended: no human can answer a question. Attended: phase-2 live attach (spec §4.6). */
export type PromoteMode = 'unattended' | 'attended';

export interface DroppedSkill {
  name: string;
  reason: DropReason;
  detail: string;
}

export interface Classification {
  travels: ResolvedSkill[];
  dropped: DroppedSkill[];
  /** Travels, but degrades without a human. Warned under `unattended` only. */
  interactionDependent: string[];
}

export interface ClassifyOptions {
  mode: PromoteMode;
  userDenyList?: string[];
}

export type SecretSeverity = 'blocking' | 'warning';

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  severity: SecretSeverity;
}

export interface LockfileSkillRecord {
  name: string;
  scope: SkillScope;
  sourceDir: string;
  contentHash: string;
}

export interface BundleLockfile {
  binaries: string[];
  builtAgainst: { harness: string; pi: string };
  context: string[];
  digest: string;
  dropped: DroppedSkill[];
  entry: string;
  formatVersion: number;
  interactionDependent: string[];
  memory: string[];
  mode: PromoteMode;
  sandboxImage: string;
  skills: LockfileSkillRecord[];
}

export interface LockfileInput {
  digest: string;
  mode: PromoteMode;
  entry: string;
  classification: Classification;
  contextPaths: string[];
  memoryPaths: string[];
  sandboxImage: string;
  binaries: string[];
  versions: { pi: string; harness: string };
  skillHashes: Record<string, string>;
}
