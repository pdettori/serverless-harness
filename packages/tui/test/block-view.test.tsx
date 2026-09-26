import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Block } from '../src/render/blocks.js';
import { BlockView } from '../src/views/BlockView.js';
import { withTheme } from './helpers/ink.js';

const view = (block: Block, details = false, thinking = true) =>
  render(
    withTheme(<BlockView block={block} details={details} thinking={thinking} width={80} />),
  ).lastFrame() ?? '';

describe('BlockView', () => {
  it('shows a user prompt, marking a queued one', () => {
    expect(view({ kind: 'user', id: 0, text: 'fix it' })).toContain('› fix it');
    expect(view({ kind: 'user', id: 0, text: 'later', queued: true })).toContain('(queued)');
  });

  it('renders a finished reply as Markdown but a streaming one verbatim', () => {
    expect(
      view({ kind: 'assistant', id: 0, text: 'a **b**', thinking: '', final: true }),
    ).not.toContain('**');
    expect(view({ kind: 'assistant', id: 0, text: 'a **b', thinking: '', final: false })).toContain(
      'a **b',
    );
  });

  it('shows thinking only when the toggle is on', () => {
    const b: Block = {
      kind: 'assistant',
      id: 0,
      text: 'answer',
      thinking: 'pondering',
      final: true,
    };
    expect(view(b, false, true)).toContain('pondering');
    expect(view(b, false, false)).not.toContain('pondering');
  });

  it('shows a running tool with a spinner and a finished one with a mark', () => {
    const running: Block = {
      kind: 'tool',
      id: 0,
      toolId: 't',
      name: 'bash',
      args: { command: 'ls -la' },
    };
    expect(view(running)).toContain('… $ ls -la');
    expect(view({ ...running, result: { isError: false, preview: 'a.ts' } })).toContain(
      '✓ $ ls -la',
    );
  });

  it('hides a tool preview when collapsed and shows it when expanded', () => {
    const b: Block = {
      kind: 'tool',
      id: 0,
      toolId: 't',
      name: 'bash',
      args: { command: 'ls' },
      result: { isError: false, preview: 'a.ts\nb.ts' },
    };
    expect(view(b, false)).not.toContain('b.ts');
    expect(view(b, true)).toContain('b.ts');
  });

  it('caps an expanded preview at 12 lines', () => {
    const preview = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const out = view(
      {
        kind: 'tool',
        id: 0,
        toolId: 't',
        name: 'bash',
        args: { command: 'x' },
        result: { isError: false, preview },
      },
      true,
    );
    expect(out).toContain('line11');
    expect(out).not.toContain('line12');
    expect(out).toContain('18 more lines');
  });

  it('shows the first line of an error even when collapsed', () => {
    const out = view({
      kind: 'tool',
      id: 0,
      toolId: 't',
      name: 'bash',
      args: { command: 'x' },
      result: { isError: true, preview: 'command not found\nmore' },
    });
    expect(out).toContain('✗ $ x');
    expect(out).toContain('command not found');
    expect(out).not.toContain('more');
  });

  it('renders an edit as a diff when expanded', () => {
    const out = view(
      {
        kind: 'tool',
        id: 0,
        toolId: 't',
        name: 'edit',
        args: { path: 'a.ts', edits: [{ oldText: 'let x', newText: 'const x' }] },
        result: { isError: false, preview: 'ok' },
      },
      true,
    );
    expect(out).toContain('edit a.ts · +1 −1');
    expect(out).toContain('- let x');
    expect(out).toContain('+ const x');
  });

  it('truncates long diff lines to the render width', () => {
    const out = view(
      {
        kind: 'tool',
        id: 0,
        toolId: 't',
        name: 'edit',
        args: { path: 'a.ts', edits: [{ oldText: 'let x', newText: 'x'.repeat(300) }] },
        result: { isError: false, preview: 'ok' },
      },
      true,
    );
    for (const line of stripVTControlCharacters(out).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('shows the error preview alongside the attempted diff for a failed edit', () => {
    const out = view(
      {
        kind: 'tool',
        id: 0,
        toolId: 't',
        name: 'edit',
        args: { path: 'a.ts', edits: [{ oldText: 'let x', newText: 'const x' }] },
        result: { isError: true, preview: 'oldText not found in a.ts' },
      },
      true,
    );
    expect(out).toContain('oldText not found in a.ts');
    expect(out).toContain('- let x');
    expect(out).toContain('+ const x');
    expect(out.indexOf('oldText not found')).toBeLessThan(out.indexOf('- let x'));
  });

  it('shows pretty-printed args for an unknown tool only when expanded, followed by the preview', () => {
    const b: Block = {
      kind: 'tool',
      id: 0,
      toolId: 't',
      name: 'mcp_call',
      args: { query: 'x', limit: 5 },
      result: { isError: false, preview: 'done' },
    };
    const collapsed = view(b, false);
    expect(collapsed).not.toContain('"query": "x"');
    expect(collapsed).not.toContain('done');

    const expanded = view(b, true);
    expect(expanded).toContain('"query": "x"');
    expect(expanded).toContain('done');
    expect(expanded.indexOf('"query": "x"')).toBeLessThan(expanded.indexOf('done'));
  });

  it('renders turn ends: usage, errors and cancellation', () => {
    expect(
      view({
        kind: 'turn-end',
        id: 0,
        outcome: 'done',
        usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, total: 160 },
      }),
    ).toContain('120 in · 40 out');
    expect(view({ kind: 'turn-end', id: 0, outcome: 'error', message: 'model refused' })).toContain(
      '✗ model refused',
    );
    expect(view({ kind: 'turn-end', id: 0, outcome: 'cancelled' })).toContain('cancelled');
  });

  it('renders an unknown event generically and a notice verbatim', () => {
    expect(view({ kind: 'event', id: 0, label: 'paused', data: { gateId: 3 } })).toContain(
      'paused {"gateId":3}',
    );
    expect(
      view({
        kind: 'notice',
        id: 0,
        text: 'history for this session is not available on this device',
        tone: 'info',
      }),
    ).toContain('not available on this device');
  });
});
