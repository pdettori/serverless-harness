import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Needs a reachable control plane and harness (SH_CONTROL_PLANE_URL, SH_HARNESS_URL) and a prior
// `sh-tui login`. Optionally TUI_SMOKE_CREDENTIAL names the inference credential to use when the
// account has several.
const live = process.env.TUI_LIVE_SMOKE === '1';
const bin = new URL('../bin/sh-tui.mjs', import.meta.url).pathname;
const run = (args: string[], timeout: number) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: process.env, timeout });

describe.skipIf(!live)('sh-tui live smoke (TUI_LIVE_SMOKE=1)', () => {
  it('doctor passes every check', () => {
    const r = run(['doctor', '--json'], 60_000);
    expect(r.status, r.stderr).toBe(0);
    expect(
      (JSON.parse(r.stdout) as Array<{ status: string }>).every((c) => c.status === 'pass'),
    ).toBe(true);
  }, 70_000);

  it('run streams text and ends with done', () => {
    const credential = process.env.TUI_SMOKE_CREDENTIAL;
    const r = run(
      [
        'run',
        'Reply with the single word: pong',
        '--json',
        ...(credential ? ['--option', `inferenceCredential=${credential}`] : []),
      ],
      180_000,
    );
    expect(r.status, r.stderr).toBe(0);
    const frames = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(frames[0].type).toBe('session');
    expect(frames.some((f) => f.type === 'text')).toBe(true);
    expect(frames.at(-1)!.type).toBe('done');
  }, 200_000);
});
