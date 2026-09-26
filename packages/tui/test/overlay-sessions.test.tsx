import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/api/types.js';
import { TranscriptStore } from '../src/core/transcripts.js';
import { SessionsOverlay, sessionTitle } from '../src/views/overlays/Sessions.js';
import { fakeControlPlane } from './helpers/fakes.js';
import { KEY, pressUntil, tick, withTheme } from './helpers/ink.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0);
const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  owner: 'github:1',
  tenant: 't',
  createdAt: Date.UTC(2026, 8, 25, 9, 30),
  state: 'active',
  lastTurnAt: NOW - 3 * 3_600_000,
  turns: 4,
  ...over,
});

function setup() {
  const transcripts = new TranscriptStore(mkdtempSync(join(tmpdir(), 'sh-tui-ov-')), {
    subject: 'github:1',
    controlPlaneUrl: 'http://cp',
  });
  transcripts.appendPrompt('aaaaaaaa-1', 'Fix the payment bug');
  const cp = fakeControlPlane({
    listSessions: async () => ({
      sessions: [summary('aaaaaaaa-1'), summary('bbbbbbbb-2', { turns: 1 })],
      nextCursor: null,
    }),
  });
  const props = {
    onResume: vi.fn(),
    onNew: vi.fn(),
    onDeleted: vi.fn(),
    onCancel: vi.fn(),
    remove: vi.fn(async () => 'deleted'),
  };
  const r = render(
    withTheme(
      <SessionsOverlay
        cp={cp}
        transcripts={transcripts}
        now={() => NOW}
        currentSessionId="aaaaaaaa-1"
        {...props}
      />,
    ),
  );
  return { ...r, ...props, transcripts };
}

describe('sessionTitle', () => {
  it('falls back to creation time and a short id', () => {
    expect(sessionTitle(summary('bbbbbbbb-2'))).toBe('2026-09-25 09:30 · bbbbbbbb');
  });
});

describe('SessionsOverlay', () => {
  it('lists sessions with titles, relative times, turn counts and markers', async () => {
    const { lastFrame } = setup();
    await tick();
    const f = lastFrame()!;
    expect(f).toContain('Fix the payment bug');
    expect(f).toContain('3h ago · 4 turns · local history · current');
    expect(f).toContain('2026-09-25 09:30 · bbbbbbbb');
    expect(f).toContain('1 turn');
  });

  it('resumes the highlighted session on Enter', async () => {
    const { stdin, onResume, lastFrame } = setup();
    await tick();
    // The list's useInput subscribes in a useEffect that flushes asynchronously after this
    // first paint, and under load (confirmed running the full package suite) that can take
    // much longer than a fixed handful of ticks. Resending a harmless, idempotent keystroke
    // until it visibly takes effect rides out that lag instead of guessing a tick count.
    await pressUntil(stdin.write, KEY.down, () =>
      (lastFrame() ?? '').includes('› 2026-09-25 09:30 · bbbbbbbb'),
    );
    stdin.write(KEY.enter);
    await tick();
    expect(onResume).toHaveBeenCalledWith('bbbbbbbb-2');
  });

  it('deletes only after confirmation', async () => {
    const { stdin, remove, onDeleted, lastFrame } = setup();
    await tick();
    // See the comment in the "resumes" test above: retry rather than guess a settle time.
    await pressUntil(stdin.write, 'd', () => (lastFrame() ?? '').includes('Delete "Fix'));
    expect(lastFrame()).toContain('Delete "Fix the payment bug"?');
    // 'd' just swapped the list for a freshly-mounted Confirm, whose own useInput effect can
    // lag the same way — resending 'n' is harmless (onNo is idempotent) until it takes effect.
    await pressUntil(stdin.write, 'n', () => !(lastFrame() ?? '').includes('Delete "Fix'));
    expect(remove).not.toHaveBeenCalled();
    await pressUntil(stdin.write, 'd', () => (lastFrame() ?? '').includes('Delete "Fix'));
    await pressUntil(stdin.write, 'y', () => remove.mock.calls.length > 0);
    expect(remove).toHaveBeenCalledWith('aaaaaaaa-1');
    expect(onDeleted).toHaveBeenCalledWith('aaaaaaaa-1');
  });

  it('renames through a one-field form', async () => {
    const { stdin, transcripts, lastFrame } = setup();
    await tick();
    // See the comment in the "resumes" test above: retry rather than guess a settle time.
    await pressUntil(stdin.write, 'r', () => (lastFrame() ?? '').includes('Rename session'));
    // 'r' just swapped the list for a freshly-mounted Form, whose own useInput effect can lag
    // the same way. A backspace is safe to resend (it is a no-op once the field is empty), so
    // retry it until the field visibly shortens, proving the Form is now subscribed — then the
    // rest of the burst is safe to fire without further per-key settling.
    await pressUntil(
      stdin.write,
      KEY.backspace,
      () => !(lastFrame() ?? '').includes('Fix the payment bug'),
    );
    for (let i = 0; i < 30; i++) stdin.write(KEY.backspace);
    stdin.write('Payments');
    stdin.write(KEY.enter);
    await tick();
    expect(transcripts.load('aaaaaaaa-1')?.title).toBe('Payments');
    expect(lastFrame()).toContain('Payments');
  });

  it('starts a new session on n', async () => {
    const { stdin, onNew } = setup();
    await tick();
    // See the comment in the "resumes" test above: retry rather than guess a settle time.
    await pressUntil(stdin.write, 'n', () => onNew.mock.calls.length > 0);
    expect(onNew).toHaveBeenCalled();
  });

  it('shows a load error', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => {
        throw new Error('boom');
      },
    });
    const { lastFrame } = render(
      withTheme(
        <SessionsOverlay
          cp={cp}
          now={() => NOW}
          remove={vi.fn()}
          onResume={vi.fn()}
          onNew={vi.fn()}
          onDeleted={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    expect(lastFrame()).toContain('boom');
  });
});
