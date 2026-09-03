import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildBundleInput, PromoteMode } from '@sh/config-bundle';

/** Where the generated lockfile is written, for committing alongside the code it configures. */
export const LOCKFILE_OUT = '.claude/promoted.lock.json';

export interface PromoteArgs {
  entry: string;
  mode: PromoteMode;
  sandboxImage: string;
  deny: string[];
  dryRun: boolean;
  project?: string;
}

export function parsePromoteArgs(argv: string[]): PromoteArgs {
  const args: PromoteArgs = {
    entry: '',
    mode: 'unattended',
    // Matches deploy/knative/setup-k8s.sh:30 so the checked-in inventory (Task 14) resolves.
    sandboxImage: 'ghcr.io/rossoctl/serverless-harness-sandbox:latest',
    deny: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === '--entry') ((args.entry = value ?? ''), i++);
    else if (flag === '--mode') {
      if (value !== 'unattended' && value !== 'attended') {
        throw new Error(`--mode must be 'unattended' or 'attended', got '${value ?? ''}'`);
      }
      args.mode = value;
      i++;
    } else if (flag === '--sandbox-image') ((args.sandboxImage = value ?? ''), i++);
    else if (flag === '--deny') (args.deny.push(value ?? ''), i++);
    else if (flag === '--project') {
      if (!value) throw new Error('--project requires a directory');
      args.project = value;
      i++;
    } else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.entry) throw new Error('usage: sh promote --entry <prompt-name> [--mode attended]');
  return args;
}

/**
 * The project directory to promote from: `--project` resolved to an absolute path, or `cwd`
 * (the process's own working directory) when `--project` was not given.
 *
 * This is the fix for the only shipped invocation (`cd harness && pnpm promote`) silently
 * promoting the harness checkout's own configuration: `pnpm run` sets `cwd` to the package
 * directory, not the directory the caller actually meant, so an explicit `--project` is the only
 * reliable way to name "the project" from inside a workspace script.
 */
export function resolveProjectDir(args: Pick<PromoteArgs, 'project'>, cwd: string): string {
  return args.project !== undefined ? resolve(args.project) : cwd;
}

/**
 * Mirror Claude Code's own project slug: path separators replaced with '-'.
 *
 * This scheme is lossy -- `/a/my-project` and `/a/my/project` both slug to `-a-my-project` -- and
 * that is INHERITED ON PURPOSE. Verified against a real install: the directory Claude Code created
 * for this repo is `-Users-paolo-Projects-aiplatform-serverless-harness`, hyphen in the final
 * segment and all. Our job is to FIND the directory Claude Code already made, so a "safer",
 * collision-free scheme would simply miss it and silently promote no memory at all. Do not
 * "improve" this.
 */
export function projectMemoryDir(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', cwd.split(/[/\\]/).join('-'), 'memory');
}

/** Relative location of the checked-in sandbox inventories, from a repo or package root. */
export const INVENTORY_SUBDIR = join('deploy', 'knative', 'sandbox-inventory');

/** The inventory filename for an image ref: `:` and `/` become `_`. Mirrors readInventory's key. */
export function inventoryFileName(image: string): string {
  return `${image.replace(/[:/]/g, '_')}.json`;
}

/**
 * Candidate inventory paths for an image, in precedence order.
 *
 * The inventory is a HARNESS-SHIPPED asset, so it must be found relative to where the harness is
 * installed -- NOT relative to the invocation directory. `sh promote` is run from the user's own
 * project (that is the whole point of the feature), and a user's project will never contain
 * `deploy/knative/sandbox-inventory/`. Resolving against `cwd` alone made the binary check
 * silently degrade to `inventory_unavailable` for every real caller, which is the "lying
 * preflight" this inventory exists to prevent -- measured: from the repo root the check produced
 * 29 findings, from one directory deeper it produced none.
 *
 * `cwd` is kept as a LOWER-precedence fallback so a caller can still override with a local file.
 */
export function inventoryCandidates(image: string, cwd: string, moduleDir: string): string[] {
  const file = inventoryFileName(image);
  const out: string[] = [];
  // Walk up from the module: src/ -> package -> repo root (and any bundling layout in between).
  let dir = moduleDir;
  for (;;) {
    out.push(join(dir, INVENTORY_SUBDIR, file));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push(join(cwd, INVENTORY_SUBDIR, file));
  return out;
}

/**
 * The first existing inventory path for an image, or undefined.
 *
 * Exposed separately from `readInventory` so the CLI can SAY which file it used. The precedence
 * is deliberately silent-proof: a shipped inventory outranks a cwd-local one, so without a
 * diagnostic a caller who deliberately dropped an override next to their project would be
 * shadowed by the shipped copy with no way to tell.
 */
export function resolveInventoryPath(
  image: string,
  cwd: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  return inventoryCandidates(image, cwd, moduleDir).find((path) => existsSync(path));
}

/** Checked-in inventory for a sandbox image tag; absent => preflight warns instead of verifying. */
export function readInventory(
  image: string,
  cwd: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string[] | undefined {
  const path = resolveInventoryPath(image, cwd, moduleDir);
  if (path === undefined) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')).binaries as string[];
}

/**
 * The nearest ancestor holding a `.git` entry, or `cwd` when there is none.
 *
 * This bounds the context-file walk. Without it the walk reaches the filesystem root and sweeps
 * every ancestor `CLAUDE.md` -- including a personal `~/CLAUDE.md` -- into a bundle that lands in a
 * shared Redis store.
 *
 * `existsSync` is deliberate rather than a directory check: in a linked worktree `.git` is a *file*
 * containing a `gitdir:` pointer, not a directory, and this repo uses worktrees heavily. A
 * directory-only test would walk straight past the boundary in exactly the checkout where it is
 * needed most.
 */
export function projectRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding .git, return the original cwd.
      return cwd;
    }
    dir = parent;
  }
}

/** The CLAUDE.md / AGENTS.md chain from the project root down to `cwd`, outermost first. */
export function collectContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const root = projectRoot(cwd);
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root) break;
  }
  for (const dir of dirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(dir, name);
      if (existsSync(path)) {
        out.push({ path, content: readFileSync(path, 'utf8') });
        break;
      }
    }
  }
  return out;
}

/** Assemble buildBundle's input from Claude Code's own on-disk layout. */
export function promoteInputs(opts: {
  cwd: string;
  home: string;
  args: PromoteArgs;
  inventory?: string[];
  versions: { pi: string; harness: string };
}): BuildBundleInput {
  const userDir = join(opts.home, '.claude');
  return {
    roots: {
      projectDir: join(opts.cwd, '.claude'),
      userDir,
      pluginDirs: [join(userDir, 'plugins')],
    },
    memoryDir: projectMemoryDir(opts.cwd, opts.home),
    promptsDir: join(userDir, 'commands'),
    contextFiles: collectContextFiles(opts.cwd),
    entry: opts.args.entry,
    mode: opts.args.mode,
    userDenyList: opts.args.deny,
    sandboxImage: opts.args.sandboxImage,
    ...(opts.inventory ? { inventory: opts.inventory } : {}),
    versions: opts.versions,
  };
}
