import type { Classification, PreflightFinding, ResolvedSkill } from './types.js';

/** Backticked tokens that look like a relative file path (have a slash or a known extension). */
function referencedPaths(skillMd: string): string[] {
  const out = new Set<string>();
  for (const m of skillMd.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1]!.trim();
    if (!token || /^https?:\/\//.test(token) || token.startsWith('-')) continue;
    if (/\s/.test(token)) continue;
    // Extension must start with a letter (kills versions like 1.2.3, IPs like 127.0.0.1)
    if (!/\.[a-z][a-z0-9]{0,4}$/i.test(token)) continue;
    // Reject tokens with glob/comparison operators (kills *.md, node>=18.0, etc)
    if (/[*?<>=|]/.test(token)) continue;
    out.add(token.replace(/^\.\//, ''));
  }
  return [...out];
}

/**
 * A skill referencing a sibling that is not in the bundle would fail remotely as a confusing
 * read miss, so it is an error here (spec §4.6, tier 1). A reference is considered satisfied if
 * any bundled file path ends with it — skills write paths relative to their own dir or to the
 * plugin root, and both forms are legitimate.
 */
export function checkSiblingPaths(skills: ResolvedSkill[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const skill of skills) {
    for (const ref of referencedPaths(skill.skillMd)) {
      const satisfied = skill.files.some(
        (f) => f === ref || f.endsWith('/' + ref) || ref.endsWith(f),
      );
      if (!satisfied) {
        findings.push({
          severity: 'error',
          code: 'missing_sibling',
          message: `skill '${skill.name}' references '${ref}', which is not in its directory`,
          path: skill.dir,
        });
      }
    }
  }
  return findings;
}

/** Skip non-local link targets (external URLs, protocol-relative, fragments, queries, or outside memory dir). */
function isLocalMemoryLink(target: string): boolean {
  // Has URI scheme (https:, http:, mailto:, etc)
  if (/^[a-z][a-z0-9+.-]*:/.test(target)) return false;
  // Protocol-relative
  if (/^\/\//.test(target)) return false;
  // Fragment or query-only
  if (/^[#?]/.test(target)) return false;
  // Contains .. path segment (outside memory directory)
  if (/\.\./.test(target)) return false;
  return true;
}

/** Dangling links in MEMORY.md (both markdown `[title](file.md)` and `[[wikilink]]` forms) — usually deny-listed memory files. Warn, not error. */
export function checkMemoryLinks(
  memoryIndex: string | undefined,
  includedMemoryNames: string[],
): PreflightFinding[] {
  if (!memoryIndex) return [];
  const slugs = new Set(includedMemoryNames.map((n) => n.replace(/\.md$/, '')));
  const findings: PreflightFinding[] = [];

  // Extract markdown links: [Title](target.md)
  for (const m of memoryIndex.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = m[2]!.trim();
    // Skip non-local targets (external URLs, relative paths outside memory, etc)
    if (!isLocalMemoryLink(target)) continue;
    // Strip directory prefix and .md extension
    const slug = target.replace(/^.*\//, '').replace(/\.md$/, '');
    if (!slugs.has(slug)) {
      findings.push({
        severity: 'warn',
        code: 'dangling_memory_link',
        message: `MEMORY.md links [${m[1]}](${target}), which is not included in the bundle`,
      });
    }
  }

  // Extract wikilinks: [[slug]] or [[slug|alias]] or [[path/slug]]
  for (const m of memoryIndex.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const full = m[1]!.trim();
    // Strip |alias suffix
    const withoutAlias = full.split('|')[0]!.trim();
    // Skip non-local targets (external URLs, relative paths outside memory, etc)
    if (!isLocalMemoryLink(withoutAlias)) continue;
    // Strip path prefix to get slug
    const slug = withoutAlias.replace(/^.*\//, '');
    if (!slugs.has(slug)) {
      findings.push({
        severity: 'warn',
        code: 'dangling_memory_link',
        message: `MEMORY.md links [[${full}]], which is not included in the bundle`,
      });
    }
  }

  return findings;
}

/**
 * The highest-value check: a missing `gh` is the classic silent remote failure. With no
 * inventory to compare against we WARN rather than pass silently — a check that cannot run is
 * not a check that succeeded.
 */
export function checkBinaries(
  detected: string[],
  inventory: string[] | undefined,
): PreflightFinding[] {
  if (!inventory) {
    return detected.length === 0
      ? []
      : [
          {
            severity: 'warn',
            code: 'inventory_unavailable',
            message:
              `no sandbox inventory available; ${detected.length} detected binary/binaries ` +
              `(${detected.join(', ')}) could not be verified`,
          },
        ];
  }
  const have = new Set(inventory);
  return detected
    .filter((b) => !have.has(b))
    .map((b) => ({
      severity: 'error' as const,
      code: 'missing_binary',
      message: `binary '${b}' is used by a skill but is not in the sandbox image inventory`,
    }));
}

export function checkEntry(entry: string, promptNames: string[]): PreflightFinding[] {
  return promptNames.includes(entry)
    ? []
    : [
        {
          severity: 'error',
          code: 'unknown_entry',
          message:
            `entry prompt '${entry}' is not in the bundle ` +
            `(available: ${promptNames.join(', ') || 'none'})`,
        },
      ];
}

/** Interaction dependence is mode-sensitive, so it warns and never drops (spec D8). */
export function checkInteraction(classification: Classification): PreflightFinding[] {
  return classification.interactionDependent.map((name) => ({
    severity: 'warn' as const,
    code: 'interaction_dependent',
    message:
      `skill '${name}' works by asking questions and waiting; unattended it will invent ` +
      `the answers. Use --mode attended, or exclude it.`,
  }));
}

export function hasErrors(findings: PreflightFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Human-readable report. Always states its own limits — spec §4.6 forbids implying completeness. */
export function renderPreflight(findings: PreflightFinding[]): string {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push('preflight: no findings');
  } else {
    for (const severity of ['error', 'warn', 'info'] as const) {
      const group = findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`${severity} (${group.length}):`);
      for (const f of group) {
        lines.push(`  [${f.code}] ${f.message}${f.path ? `  (${f.path})` : ''}`);
      }
    }
  }
  lines.push('');
  lines.push('Cannot be checked locally, and will only surface at run time:');
  lines.push(
    '  - a binary present in the sandbox but at a different version or with different flags',
  );
  lines.push('  - a tool present but lacking the credentials it needs');
  lines.push('  - network egress the sandbox denies');
  lines.push('  - a skill assuming host behavior that has no analogue and no mechanical signature');
  return lines.join('\n');
}
