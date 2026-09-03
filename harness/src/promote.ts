import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { BuildBundleInput, PromoteMode } from '@sh/config-bundle';

/** Where the generated lockfile is written, for committing alongside the code it configures. */
export const LOCKFILE_OUT = '.claude/promoted.lock.json';

export interface PromoteArgs {
  entry: string;
  mode: PromoteMode;
  sandboxImage: string;
  deny: string[];
  dryRun: boolean;
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
    else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.entry) throw new Error('usage: sh promote --entry <prompt-name> [--mode attended]');
  return args;
}

/** Claude Code slugs a project path by replacing separators with '-'. */
export function projectMemoryDir(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', cwd.split(/[/\\]/).join('-'), 'memory');
}

/** The CLAUDE.md / AGENTS.md chain from the filesystem root down to `cwd`, outermost first. */
export function collectContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const stop = parse(cwd).root;
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === stop || dirname(dir) === dir) break;
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
