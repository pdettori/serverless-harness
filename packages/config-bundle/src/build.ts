import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifySkills, detectBinaries } from './classify.js';
import { buildLockfile, serializeLockfile, skillContentHash } from './lockfile.js';
import { skillsRootNote, toolNameMappingNote } from './notes.js';
import {
  checkBinaries,
  checkEntry,
  checkInteraction,
  checkMemoryLinks,
  checkSiblingPaths,
} from './preflight.js';
import { resolveSkills } from './resolve.js';
import { blockingSecrets, scanEntriesForSecrets, SecretScanError } from './secret-scan.js';
import { canonicalTar, digestOf } from './tar.js';
import type { BuildBundleInput, BuildResult, PreflightFinding, TarEntry } from './types.js';

export const LOCKFILE_PATH = 'lockfile.json';

/**
 * The bundle's identity: a digest over the CONTENT entries only.
 *
 * `lockfile.json` records the digest, so including it would make the digest depend on itself.
 * Both the builder and the resolver (harness/src/config-resolver.ts) call this exact function,
 * so their notions of identity cannot drift.
 */
export function contentDigest(entries: TarEntry[]): string {
  return digestOf(canonicalTar(entries.filter((e) => e.path !== LOCKFILE_PATH)));
}

/** `.md` files directly in `dir`, sorted. Empty when the directory is absent. */
function markdownFiles(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && statSync(join(dir, n)).isFile())
    .sort();
}

export function buildBundle(input: BuildBundleInput): BuildResult {
  const classification = classifySkills(resolveSkills(input.roots), {
    mode: input.mode,
    userDenyList: input.userDenyList,
  });

  const entries: TarEntry[] = [];

  // Skill directories travel WHOLE: skills reference siblings and carry references/ subtrees.
  for (const skill of classification.travels) {
    for (const rel of skill.files) {
      const abs = join(skill.dir, rel);
      entries.push({
        path: `skills/${skill.name}/${rel}`,
        content: readFileSync(abs),
        mode: rel.endsWith('.sh') ? 0o755 : 0o644,
      });
    }
  }

  // Inline-injected context: the CLAUDE.md chain plus the memory index.
  const contextPaths: string[] = [];
  (input.contextFiles ?? []).forEach((file, i) => {
    const path = `context/agents/${i}-${basename(file.path)}`;
    entries.push({ path, content: Buffer.from(file.content, 'utf8') });
    contextPaths.push(path);
  });

  const memoryNames = markdownFiles(input.memoryDir).filter((n) => n !== 'MEMORY.md');
  let memoryIndex: string | undefined;
  if (input.memoryDir && existsSync(join(input.memoryDir, 'MEMORY.md'))) {
    memoryIndex = readFileSync(join(input.memoryDir, 'MEMORY.md'), 'utf8');
    entries.push({ path: 'context/MEMORY.md', content: Buffer.from(memoryIndex, 'utf8') });
    contextPaths.push('context/MEMORY.md');
  }

  // Memory files are read on demand IN THE SANDBOX (ADR-0031 progressive disclosure), so they
  // are bundle content rather than inline context.
  const memoryPaths: string[] = [];
  for (const name of memoryNames) {
    const path = `memory/${name}`;
    entries.push({ path, content: readFileSync(join(input.memoryDir!, name)) });
    memoryPaths.push(path);
  }

  const promptNames: string[] = [];
  for (const name of markdownFiles(input.promptsDir)) {
    entries.push({
      path: `prompts/${name}`,
      content: readFileSync(join(input.promptsDir!, name)),
    });
    promptNames.push(name.replace(/\.md$/, ''));
  }

  const fragments = [
    toolNameMappingNote(),
    skillsRootNote(),
    ...(input.extraPromptFragments ?? []),
  ];
  fragments.forEach((text, i) => {
    entries.push({ path: `prompt/append-${i}.md`, content: Buffer.from(text, 'utf8') });
  });

  // Blocking gate: a credential reaching a shared cluster's store is not recoverable by
  // re-promoting, so nothing is packed or returned when the scan is dirty (spec §4.3).
  const secrets = scanEntriesForSecrets(entries);
  const blocking = blockingSecrets(secrets);
  if (blocking.length > 0) throw new SecretScanError(blocking);

  const digest = contentDigest(entries);
  const binaries = detectBinaries(classification.travels);
  const skillHashes: Record<string, string> = {};
  for (const skill of classification.travels) {
    skillHashes[skill.name] = skillContentHash(skill, entries);
  }

  const lockfile = buildLockfile({
    digest,
    mode: input.mode,
    entry: input.entry,
    classification,
    contextPaths,
    memoryPaths,
    sandboxImage: input.sandboxImage,
    binaries,
    versions: input.versions,
    skillHashes,
  });

  const findings: PreflightFinding[] = [
    // Non-blocking secret hits travel as warnings so a human still sees them in the report.
    ...secrets
      .filter((f) => f.severity === 'warning')
      .map((f) => ({
        severity: 'warn' as const,
        code: 'possible_secret',
        message: `possible secret (${f.rule}) — verify before promoting`,
        path: `${f.path}:${f.line}`,
      })),
    ...checkSiblingPaths(classification.travels),
    ...checkMemoryLinks(memoryIndex, memoryNames),
    ...checkBinaries(binaries, input.inventory),
    ...checkEntry(input.entry, promptNames),
    ...checkInteraction(classification),
  ];

  const tar = canonicalTar([
    ...entries,
    { path: LOCKFILE_PATH, content: Buffer.from(serializeLockfile(lockfile), 'utf8') },
  ]);

  return { tar, digest, lockfile, findings, promptNames };
}
