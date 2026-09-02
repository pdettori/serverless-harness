import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ResolvedSkill, SkillRoots, SkillScope } from './types.js';

/** Parse `name:` out of YAML frontmatter. Deliberately minimal — no YAML dependency. Strips a single matched pair of surrounding double or single quotes. */
export function readSkillFrontmatterName(skillMd: string): string | null {
  if (!skillMd.startsWith('---')) return null;
  const end = skillMd.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = /^name:\s*(.+)$/m.exec(skillMd.slice(3, end));
  if (!m) return null;
  let name = m[1]!.trim();
  // Strip a single matched pair of surrounding double or single quotes
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))
  ) {
    name = name.slice(1, -1);
  }
  return name;
}

/** Every file under `dir`, relative to it, sorted. Symlinks are skipped entirely (neither collected nor descended into). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        // Skip symlinks entirely: don't collect, don't descend
      } else if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        out.push(relative(dir, p).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Pi's discovery rule (`pi-fork/.../core/skills.ts`): a directory holding SKILL.md IS a skill
 * root and is NOT recursed into; otherwise recurse looking for one. Symlinks are skipped.
 */
function findSkillDirs(root: string, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return acc;
  }
  if (!st.isDirectory()) return acc;
  if (existsSync(join(root, 'SKILL.md'))) {
    acc.push(root);
    return acc;
  }
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    let pst;
    try {
      pst = lstatSync(p);
    } catch {
      continue;
    }
    if (pst.isSymbolicLink()) {
      // Skip symlinks: don't descend
    } else if (pst.isDirectory()) {
      findSkillDirs(p, acc);
    }
  }
  return acc;
}

function load(dir: string, scope: SkillScope): ResolvedSkill {
  const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const fallback = dir.split(sep).filter(Boolean).at(-1) ?? 'skill';
  return {
    name: readSkillFrontmatterName(skillMd) ?? fallback,
    dir,
    skillMd,
    files: filesUnder(dir),
    scope,
  };
}

const SCOPE_RANK: Record<SkillScope, number> = { project: 0, user: 1, plugin: 2 };

/**
 * Resolve every skill across the configured roots, deduped by name.
 *
 * Dedupe matters concretely: `~/.claude/plugins/cache/` is largely a resolved duplicate of
 * `~/.claude/plugins/marketplaces/`, so a naive scan double-counts every plugin skill (spec §4.3).
 * Precedence is project > user > plugin; within one scope, first path wins after sorting.
 */
export function resolveSkills(roots: SkillRoots): ResolvedSkill[] {
  const found: ResolvedSkill[] = [];
  const push = (base: string | undefined, scope: SkillScope): void => {
    if (!base) return;
    for (const dir of findSkillDirs(join(base, 'skills'))) found.push(load(dir, scope));
  };
  push(roots.projectDir, 'project');
  push(roots.userDir, 'user');
  for (const pluginDir of roots.pluginDirs ?? []) {
    for (const dir of findSkillDirs(pluginDir)) found.push(load(dir, 'plugin'));
  }

  const best = new Map<string, ResolvedSkill>();
  for (const skill of found) {
    const prev = best.get(skill.name);
    if (!prev || SCOPE_RANK[skill.scope] < SCOPE_RANK[prev.scope]) best.set(skill.name, skill);
  }
  return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
