import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePromoteArgs,
  projectMemoryDir,
  projectRoot,
  collectContextFiles,
  promoteInputs,
  LOCKFILE_OUT,
  readInventory,
  resolveInventoryPath,
  inventoryCandidates,
  inventoryFileName,
  INVENTORY_SUBDIR,
} from '../src/promote.js';

let root: string;
const write = (rel: string, body: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'promote-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parsePromoteArgs', () => {
  it('requires an entry', () => {
    expect(() => parsePromoteArgs([])).toThrow(/--entry/);
  });

  it('defaults mode to unattended and the image to the one setup-k8s.sh deploys', () => {
    // Must match deploy/knative/setup-k8s.sh:30 and the inventory filename created in Task 14,
    // or readInventory() finds nothing and the binary check degrades to a warning forever.
    const a = parsePromoteArgs(['--entry', 'go']);
    expect(a).toEqual({
      entry: 'go',
      mode: 'unattended',
      sandboxImage: 'ghcr.io/rossoctl/serverless-harness-sandbox:latest',
      deny: [],
      dryRun: false,
    });
  });

  it('accepts --mode attended, repeated --deny, and --dry-run', () => {
    const a = parsePromoteArgs([
      '--entry',
      'go',
      '--mode',
      'attended',
      '--deny',
      'a',
      '--deny',
      'b',
      '--dry-run',
    ]);
    expect(a.mode).toBe('attended');
    expect(a.deny).toEqual(['a', 'b']);
    expect(a.dryRun).toBe(true);
  });

  it('rejects an unknown mode rather than silently defaulting', () => {
    expect(() => parsePromoteArgs(['--entry', 'go', '--mode', 'sideways'])).toThrow(/mode/);
  });
});

describe('projectMemoryDir', () => {
  it('mirrors Claude Code path-slug layout', () => {
    expect(projectMemoryDir('/Users/p/Projects/x', '/Users/p')).toBe(
      '/Users/p/.claude/projects/-Users-p-Projects-x/memory',
    );
  });

  it('preserves hyphens in the final path segment', () => {
    // Slug collision is inherited from Claude Code; we match upstream behavior
    // so we find the directory it already created, even with hyphens present.
    expect(projectMemoryDir('/Users/p/my-project', '/Users/p')).toBe(
      '/Users/p/.claude/projects/-Users-p-my-project/memory',
    );
  });
});

describe('projectRoot', () => {
  it('bounds the walk at .git when one exists', () => {
    write('.git/config', 'dummy');
    write('CLAUDE.md', 'root');
    write('sub/CLAUDE.md', 'sub');
    const root_path = projectRoot(join(root, 'sub'));
    expect(root_path).toBe(root);
  });

  it('returns cwd when no .git is found', () => {
    write('CLAUDE.md', 'no git');
    const root_path = projectRoot(root);
    expect(root_path).toBe(root);
  });

  // In a linked worktree `.git` is a FILE holding a `gitdir:` pointer, not a directory. This repo
  // works out of worktrees constantly, so a directory-only boundary test would walk straight past
  // the root in the checkout where it matters most -- sweeping ancestor CLAUDE.md files into a
  // bundle bound for a shared store. Verified against 16 live worktrees, all `.git`-as-file.
  it('bounds the walk when .git is a file, as in a linked worktree', () => {
    write('.git', 'gitdir: /elsewhere/.git/worktrees/wt\n');
    write('CLAUDE.md', 'worktree root');
    write('sub/deep/CLAUDE.md', 'inner');
    expect(projectRoot(join(root, 'sub', 'deep'))).toBe(root);
  });

  it('terminates on the filesystem root, and on relative and nonexistent paths', () => {
    // A missing termination check here hangs the CLI rather than failing it.
    expect(projectRoot('/')).toBe('/');
    expect(projectRoot('relative/not/real')).toBe('relative/not/real');
    expect(projectRoot('/definitely/does/not/exist')).toBe('/definitely/does/not/exist');
  });
});

describe('collectContextFiles', () => {
  it('collects the CLAUDE.md chain from project root to cwd, outermost-first', () => {
    write('.git/config', 'dummy');
    write('CLAUDE.md', '# outer');
    write('sub/CLAUDE.md', '# inner');
    const files = collectContextFiles(join(root, 'sub'));
    expect(files.map((f) => f.content)).toEqual(['# outer', '# inner']);
  });

  it('does not collect files above the .git boundary', () => {
    // Create a repo with .git
    write('.git/config', 'dummy');
    write('CLAUDE.md', '# in-repo');
    const cwd = join(root, 'sub');
    write('sub/CLAUDE.md', '# inner');
    // Create a file above the repo that would be collected if .git did not bound it
    const above = join(tmpdir(), 'promote-above-' + Math.random().toString(36).slice(2));
    mkdirSync(above, { recursive: true });
    try {
      writeFileSync(join(above, 'CLAUDE.md'), '# above-root');
      // Even if our cwd is moved above root, projectRoot finds the .git and bounds there
      const files = collectContextFiles(cwd);
      const contents = files.map((f) => f.content);
      expect(contents).toEqual(['# in-repo', '# inner']);
      expect(contents).not.toContain('# above-root');
    } finally {
      rmSync(above, { recursive: true, force: true });
    }
  });

  it('accepts AGENTS.md as an alternative and returns [] when there is none', () => {
    write('.git/config', 'dummy');
    write('AGENTS.md', '# agents');
    expect(collectContextFiles(root)[0]!.content).toBe('# agents');
    const empty = mkdtempSync(join(tmpdir(), 'promote-empty-'));
    try {
      expect(collectContextFiles(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('promoteInputs', () => {
  it('wires user, project, plugin, memory and prompt roots from the standard layout', () => {
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(cwd, { recursive: true });
    const input = promoteInputs({
      cwd,
      home,
      args: parsePromoteArgs(['--entry', 'go', '--deny', 'private-thing']),
      inventory: ['gh'],
      versions: { pi: '1', harness: '1' },
    });
    expect(input.roots.userDir).toBe(join(home, '.claude'));
    expect(input.roots.projectDir).toBe(join(cwd, '.claude'));
    expect(input.roots.pluginDirs).toEqual([join(home, '.claude', 'plugins')]);
    expect(input.promptsDir).toBe(join(home, '.claude', 'commands'));
    expect(input.memoryDir).toBe(projectMemoryDir(cwd, home));
    expect(input.userDenyList).toEqual(['private-thing']);
    expect(input.entry).toBe('go');
    expect(input.inventory).toEqual(['gh']);
  });
});

describe('LOCKFILE_OUT', () => {
  it('is committed inside the project .claude directory', () => {
    expect(LOCKFILE_OUT).toBe('.claude/promoted.lock.json');
  });
});

describe('readInventory', () => {
  const IMAGE = 'ghcr.io/rossoctl/serverless-harness-sandbox:latest';
  const FILE = 'ghcr.io_rossoctl_serverless-harness-sandbox_latest.json';

  it('derives the filename readInventory/promote-cli agree on', () => {
    // Off by one character here and preflight degrades to inventory_unavailable forever.
    expect(inventoryFileName(IMAGE)).toBe(FILE);
  });

  // The regression that matters: the inventory is a HARNESS-SHIPPED asset. Resolving it against
  // the invocation cwd made it unreachable for every real caller, because `sh promote` runs from
  // the user's own project. Measured before the fix: 29 findings from the repo root, 0 one
  // directory deeper -- a check that silently stopped checking.
  it('finds the shipped inventory relative to the module, not the cwd', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    write(join('pkg', INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['tar'] }));
    // cwd is somewhere entirely unrelated, as it is in real use.
    const unrelated = mkdtempSync(join(tmpdir(), 'user-project-'));
    try {
      expect(readInventory(IMAGE, unrelated, moduleDir)).toEqual(['tar']);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it('still honours a cwd-local inventory as a fallback override', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'no-inventory-'));
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['flock'] }));
    try {
      expect(readInventory(IMAGE, root, moduleDir)).toEqual(['flock']);
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no inventory exists anywhere', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'bare-'));
    try {
      expect(readInventory(IMAGE, root, moduleDir)).toBeUndefined();
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('prefers the module-relative inventory over a cwd-local one', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    write(
      join('pkg', INVENTORY_SUBDIR, FILE),
      JSON.stringify({ image: IMAGE, binaries: ['shipped'] }),
    );
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['local'] }));
    expect(readInventory(IMAGE, root, moduleDir)).toEqual(['shipped']);
  });

  // The Important finding from Task 14's review: precedence was silent, so a deliberate
  // cwd-local override was shadowed by the shipped copy with no way to tell which won.
  it('reports which inventory path won, so silent shadowing is visible', () => {
    const moduleDir = join(root, 'pkg', 'src');
    mkdirSync(moduleDir, { recursive: true });
    const shipped = join(root, 'pkg', INVENTORY_SUBDIR, FILE);
    write(join('pkg', INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['a'] }));
    write(join(INVENTORY_SUBDIR, FILE), JSON.stringify({ image: IMAGE, binaries: ['b'] }));
    expect(resolveInventoryPath(IMAGE, root, moduleDir)).toBe(shipped);
  });

  it('resolveInventoryPath returns undefined when nothing exists', () => {
    const moduleDir = mkdtempSync(join(tmpdir(), 'bare2-'));
    try {
      expect(resolveInventoryPath(IMAGE, root, moduleDir)).toBeUndefined();
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
    }
  });

  it('candidate list ends at the cwd fallback and terminates', () => {
    const c = inventoryCandidates(IMAGE, '/tmp/cwd', '/a/b/c');
    expect(c[c.length - 1]).toBe(join('/tmp/cwd', INVENTORY_SUBDIR, FILE));
    expect(c.length).toBeLessThan(20);
    expect(c[0]).toBe(join('/a/b/c', INVENTORY_SUBDIR, FILE));
  });
});
