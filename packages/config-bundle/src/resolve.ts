import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

/** Every file under `dir`, relative to it, sorted. Symlinks are followed; cycles are broken by tracking canonical paths. */
function filesUnder(dir: string, visited = new Set<string>()): string[] {
  let canonical: string;
  try {
    canonical = realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(canonical)) return [];
  visited.add(canonical);

  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        let pCanonical: string;
        try {
          pCanonical = realpathSync(p);
        } catch {
          continue;
        }
        if (!visited.has(pCanonical)) {
          visited.add(pCanonical);
          walk(p);
        }
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
 * root and is NOT recursed into; otherwise recurse looking for one. Symlinks are followed;
 * cycles and aliases are broken by canonical path.
 */
function findSkillDirs(root: string, acc: string[] = [], visited = new Set<string>()): string[] {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    return acc;
  }
  if (visited.has(canonical)) return acc;

  let st;
  try {
    st = statSync(root);
  } catch {
    return acc;
  }
  if (!st.isDirectory()) return acc;

  visited.add(canonical);

  if (existsSync(join(root, 'SKILL.md'))) {
    acc.push(root);
    return acc;
  }
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    let pst;
    try {
      pst = statSync(p);
    } catch {
      continue;
    }
    if (pst.isDirectory()) {
      let pCanonical: string;
      try {
        pCanonical = realpathSync(p);
      } catch {
        continue;
      }
      if (!visited.has(pCanonical)) {
        findSkillDirs(p, acc, visited);
      }
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
 * Resolve every skill across the configured roots, deduped by name and canonical path.
 *
 * Deduping happens at two levels: by name (project > user > plugin precedence within a scope),
 * and by canonical path (symlinked aliases are recognized and collapsed).
 *
 * Dedupe matters concretely: `~/.claude/plugins/cache/` is largely a resolved duplicate of
 * `~/.claude/plugins/marketplaces/`, so a naive scan double-counts every plugin skill (spec §4.3).
 * Additionally, a skill directory can be aliased via symlinks, which we detect and dedupe.
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
  const byCanonical = new Map<string, ResolvedSkill>();

  for (const skill of found) {
    let canonical: string;
    try {
      canonical = realpathSync(skill.dir);
    } catch {
      canonical = skill.dir;
    }

    const prev = best.get(skill.name);
    const prevCanonical = byCanonical.get(canonical);

    if (prevCanonical) {
      // Same canonical path: prefer higher precedence scope
      if (SCOPE_RANK[skill.scope] < SCOPE_RANK[prevCanonical.scope]) {
        best.set(skill.name, skill);
        byCanonical.set(canonical, skill);
      }
    } else if (!prev || SCOPE_RANK[skill.scope] < SCOPE_RANK[prev.scope]) {
      // New name or higher precedence scope
      best.set(skill.name, skill);
      byCanonical.set(canonical, skill);
    }
  }
  return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
