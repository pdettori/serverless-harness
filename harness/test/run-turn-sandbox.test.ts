import { describe, it, expect } from 'vitest';
import { resolveTurnSandbox } from '../src/run-turn.js';

// executeTurn resolved its sandbox from process.env unconditionally (ADR 0028: prompt leaves
// "inherit /turn's sandbox routing"), which left a leased pool sandbox — and the whole remote
// relay transport — unreachable from a prompt leaf. resolveTurnSandbox is the seam: a caller
// that has already leased a sandbox injects it; /turn injects nothing and keeps env resolution.
describe('resolveTurnSandbox', () => {
  it('returns the injected sandbox verbatim, including its transport', async () => {
    const transport = {
      exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
      close: async () => {},
    };
    const injected = {
      config: { pod: 'sbx-laptop', namespace: 'default', podCwd: '/workspace', headCwd: '/head' },
      transport,
    };

    const got = await resolveTurnSandbox(injected, {}, '/head');

    expect(got).toEqual(injected);
    expect(got.transport).toBe(transport);
  });

  it('ignores env resolution entirely when a sandbox is injected', async () => {
    // A leased remote sandbox must win over an ambient KAGENTI_SANDBOX_POD: honouring the env
    // here would silently route a remote prompt leaf back to an in-cluster pod.
    const injected = {
      config: { pod: 'sbx-leased', namespace: 'default', podCwd: '/workspace', headCwd: '/head' },
    };

    const got = await resolveTurnSandbox(injected, { KAGENTI_SANDBOX_POD: 'sandbox-0' }, '/head');

    expect(got.config?.pod).toBe('sbx-leased');
  });

  it('falls back to env resolution when nothing is injected (the /turn path)', async () => {
    const got = await resolveTurnSandbox(undefined, { KAGENTI_SANDBOX_POD: 'sandbox-0' }, '/head');

    expect(got.config).toMatchObject({
      pod: 'sandbox-0',
      namespace: 'default',
      podCwd: '/workspace',
      headCwd: '/head',
    });
    expect(got.transport).toBeUndefined();
  });

  it('resolves to a null config when neither injected nor configured (tools run local)', async () => {
    const got = await resolveTurnSandbox(undefined, {}, '/head');

    expect(got).toEqual({ config: null });
  });
});
