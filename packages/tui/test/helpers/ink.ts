import { createElement, type ReactNode } from 'react';
import { ThemeProvider } from '../../src/theme/context.js';
import { resolveTheme, type Theme } from '../../src/theme/tokens.js';

export const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ink's `useInput` subscribes inside a `useEffect`, which React flushes asynchronously after
 * paint. A component that mounts (the initial render once async data resolves, or a later
 * state transition that swaps in a new child — e.g. a SelectList replaced by a Form) can
 * therefore have its keystroke handler not registered yet even though the frame already shows
 * its content. A fixed number of ticks is a guess that can still lose under enough event-loop
 * contention — confirmed empirically running the full package suite concurrently, where a
 * two-tick settle that was reliable in isolation still failed most of the time. This instead
 * resends `key` at each interval until `isDone()` reports the expected effect, bounded by
 * `attempts`. Only use it with a key whose resend is harmless if it lands twice (e.g.
 * re-selecting the same mode, or backspacing again).
 */
export async function pressUntil(
  write: (data: string) => void,
  key: string,
  isDone: () => boolean,
  { attempts = 40, intervalMs = 20 }: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < attempts && !isDone(); i++) {
    write(key);
    await tick(intervalMs);
  }
}

export const KEY = {
  enter: '\r',
  escape: '\u001B',
  up: '\u001B[A',
  down: '\u001B[B',
  backspace: '\u007F',
  tab: '\t',
  ctrl: (letter: string) => String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96),
};

export function withTheme(node: ReactNode, theme: Theme = resolveTheme('system', {}, true)) {
  return createElement(ThemeProvider, { value: theme }, node);
}
