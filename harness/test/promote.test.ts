import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePromoteArgs,
  projectMemoryDir,
  collectContextFiles,
  promoteInputs,
  LOCKFILE_OUT,
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
});

describe('collectContextFiles', () => {
  it('collects the CLAUDE.md chain outermost-first', () => {
    write('CLAUDE.md', '# outer');
    write('sub/CLAUDE.md', '# inner');
    const files = collectContextFiles(join(root, 'sub'));
    expect(files.map((f) => f.content)).toEqual(['# outer', '# inner']);
  });

  it('accepts AGENTS.md as an alternative and returns [] when there is none', () => {
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
