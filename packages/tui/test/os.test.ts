import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/config.js';
import { editorCommand, openCommand, realOs, writeExport } from '../src/os.js';

describe('editorCommand', () => {
  it('prefers VISUAL, then EDITOR, then vi', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toBe('code --wait');
    expect(editorCommand({ EDITOR: 'nano' })).toBe('nano');
    expect(editorCommand({})).toBe('vi');
  });
});

describe('openCommand', () => {
  it('uses the platform opener', () => {
    expect(openCommand('darwin', 'https://x')).toEqual({ cmd: 'open', args: ['https://x'] });
    expect(openCommand('linux', 'https://x')).toEqual({ cmd: 'xdg-open', args: ['https://x'] });
    expect(openCommand('win32', 'https://x')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'https://x'],
    });
  });
});

describe('editText', () => {
  it('returns what the editor saved, without the trailing newline', () => {
    // A fake "editor": a shell command that appends a line to the file it is given.
    const os = realOs({ EDITOR: 'sh -c \'printf "%s\\n" "$(cat "$0") edited" > "$0"\'' });
    expect(os.editText('draft')).toBe('draft edited');
  });
});

describe('writeExport', () => {
  it('writes a private Markdown file under the exports directory', () => {
    const paths = resolvePaths({}, mkdtempSync(join(tmpdir(), 'sh-tui-os-')));
    const file = writeExport(paths, 's1', '# hi\n');
    expect(file).toBe(join(paths.exportsDir, 's1.md'));
    expect(readFileSync(file, 'utf8')).toBe('# hi\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
