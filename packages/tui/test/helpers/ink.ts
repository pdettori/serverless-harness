import { createElement, type ReactNode } from 'react';
import { ThemeProvider } from '../../src/theme/context.js';
import { resolveTheme, type Theme } from '../../src/theme/tokens.js';

export const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

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
