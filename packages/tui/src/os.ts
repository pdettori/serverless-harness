import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from './config.js';

export interface OsDeps {
  copy(text: string): Promise<void>;
  openUrl(url: string): void;
  editText(initial: string): string;
  openInEditor(file: string): void;
}

export function editorCommand(env: NodeJS.ProcessEnv): string {
  return env.VISUAL || env.EDITOR || 'vi';
}

export function openCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

// The editor string is the user's own ($VISUAL/$EDITOR, which may carry flags such as
// `code --wait`), so it goes through the shell. The file path is ours, but it can still contain
// spaces (mkdtempSync(tmpdir()) is not guaranteed space-free) or shell metacharacters, and
// JSON.stringify quoting is not shell-safe for `$`/backticks — so instead of interpolating the
// path into the command string, it is passed as a positional argument ($1) to `sh -c`, with
// 'sh' itself as $0 (the conventional placeholder for the script name in error messages).
function runEditor(env: NodeJS.ProcessEnv, file: string): void {
  spawnSync('/bin/sh', ['-c', `${editorCommand(env)} "$1"`, 'sh', file], { stdio: 'inherit' });
}

export function realOs(env: NodeJS.ProcessEnv = process.env): OsDeps {
  return {
    async copy(text) {
      const { default: clipboard } = await import('clipboardy');
      await clipboard.write(text);
    },
    openUrl(url) {
      const { cmd, args } = openCommand(process.platform, url);
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
    },
    editText(initial) {
      const dir = mkdtempSync(join(tmpdir(), 'sh-tui-edit-'));
      const file = join(dir, 'prompt.md');
      try {
        writeFileSync(file, initial, { mode: 0o600 });
        runEditor(env, file);
        return readFileSync(file, 'utf8').replace(/\n$/, '');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    openInEditor(file) {
      runEditor(env, file);
    },
  };
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function writeExport(paths: Paths, sessionId: string, markdown: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`refusing unsafe session id: ${sessionId}`);
  mkdirSync(paths.exportsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.exportsDir, 0o700);
  const file = join(paths.exportsDir, `${sessionId}.md`);
  writeFileSync(file, markdown, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
