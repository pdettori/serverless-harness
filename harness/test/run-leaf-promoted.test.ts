import { describe, it, expect, vi } from 'vitest';

// `runPromptLeaf` leases a sandbox via selectPoolSandbox, which reads real process.env — with no
// KAGENTI_SANDBOX_POOL_SELECTOR and no resolvable pod config it returns null, so the `if (selected)`
// overlay branch would never run and any test aiming at it would be unreachable. Mock the module the
// way harness/test/run-leaf.test.ts:11-34 already does, and mock @sh/k8s-sandbox so KubectlTransport
// is a spy rather than a real kubectl invocation.
const { selectPoolSandboxMock, FakeSandboxPoolSaturatedError } = vi.hoisted(() => {
  class FakeSandboxPoolSaturatedError extends Error {
    constructor(selector: string) {
      super(`sandbox pool '${selector}' saturated: all pods at capacity`);
      this.name = 'SandboxPoolSaturatedError';
    }
  }
  return { selectPoolSandboxMock: vi.fn(), FakeSandboxPoolSaturatedError };
});
vi.mock('../src/select-sandbox.js', () => ({
  selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
  SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
}));

const { k8sSandboxExtensionMock, kubectlTransportMock } = vi.hoisted(() => ({
  k8sSandboxExtensionMock: vi.fn(() => () => {}),
  kubectlTransportMock: vi.fn(() => ({
    exec: vi.fn(async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock('@sh/k8s-sandbox', () => ({
  k8sSandboxExtension: (...args: unknown[]) => k8sSandboxExtensionMock(...args),
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

import { runLeaf, type LeafEnvelope } from '../src/run-leaf.js';

const FAKE_CONFIG = { podName: 'sbx-0', namespace: 'team1' } as never;
/** A pod-shaped lease: config present, transport ABSENT — the default deployment. */
const podLease = () => ({
  config: FAKE_CONFIG,
  heartbeat: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
});

const digest = 'sha256:' + 'c'.repeat(64);

const env = (extra: Partial<LeafEnvelope> = {}): LeafEnvelope =>
  ({
    sessionId: 'run-1/i1',
    item: { item_id: 'i1', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Summarize the repo.',
    ...extra,
  }) as LeafEnvelope;

const fakePromoted = {
  digest,
  root: '/tmp/sh-config/x',
  skillsDir: '/tmp/sh-config/x/skills',
  promptsDir: '/tmp/sh-config/x/prompts',
  context: [],
  promptFragments: [],
  entries: [{ path: 'skills/k/SKILL.md', content: Buffer.from('b') }],
};

const okTurn = () =>
  vi.fn(async () => ({
    sessionId: 'run-1-i1',
    response: 'text',
    stopReason: 'end_turn',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  }));

describe('configRef on a prompt leaf', () => {
  it('does not resolve or overlay anything when configRef is absent', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null); // no lease: keep this case hermetic
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn();
    const overlayConfig = vi.fn();
    const r = await runLeaf(env(), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig,
    });
    expect(r.status).toBe('responded');
    expect(resolvePromotedConfig).not.toHaveBeenCalled();
    expect(overlayConfig).not.toHaveBeenCalled();
    expect(executeTurn.mock.calls[0]![0].promotedConfig).toBeUndefined();
  });

  it('resolves the bundle and passes it to executeTurn when configRef is present', async () => {
    const executeTurn = okTurn();
    const resolvePromotedConfig = vi.fn(async () => fakePromoted);
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease()); // pod path: no grpc transport
    const overlayConfig = vi.fn(async () => ({
      skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
      memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
    }));
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig,
      overlayConfig,
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    expect(resolvePromotedConfig).toHaveBeenCalledWith(expect.anything(), digest);
    // Assert on fields, NOT object identity: when a lease exists the overlay appends a prompt
    // fragment and rebuilds promotedConfig, so `.toBe(fakePromoted)` would only pass in the
    // no-lease case and would silently break the moment the overlay ran.
    expect(executeTurn.mock.calls[0]![0].promotedConfig).toMatchObject({
      digest: fakePromoted.digest,
    });
  });

  it('fails the leaf with reason error when the bundle cannot be resolved', async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue(null); // no lease: keep this case hermetic
    const executeTurn = okTurn();
    const r = await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => {
        throw new Error('config bundle not found: ' + digest);
      }),
      overlayConfig: vi.fn(),
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('error');
    expect(r.message).toContain(digest);
    // It must NOT have run the turn unconfigured.
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('overlays even when the lease has NO grpc transport (the default pod deployment)', async () => {
    // Regression guard for a real plan defect: guarding on `selected.transport` skipped the overlay
    // on pods, so the sandbox half of the bundle silently never arrived. A fake-transport test
    // cannot catch that, so this asserts the overlay is invoked at all.
    kubectlTransportMock.mockClear();
    const executeTurn = okTurn();
    const overlayConfig = vi.fn(async () => ({
      skillsDir: '/workspace/leaves/run-1-i1/.sh-config/skills',
      memoryDir: '/workspace/leaves/run-1-i1/.sh-config/memory',
    }));
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease()); // pod path: no grpc transport
    await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig,
      bundleRedis: {} as never,
    });
    expect(overlayConfig).toHaveBeenCalledTimes(1);
    const fragments = executeTurn.mock.calls[0]![0].promotedConfig.promptFragments;
    expect(fragments.some((f: string) => f.includes('/.sh-config/skills'))).toBe(true);
    // Pin the fallback itself, not just that the overlay ran: with a transport-less (pod) lease,
    // the code must genuinely build a KubectlTransport for the overlay call, and — since it built
    // one rather than reusing a leased one — must close it afterward.
    expect(kubectlTransportMock).toHaveBeenCalledTimes(1);
    const builtTransport = kubectlTransportMock.mock.results[0]!.value;
    expect(builtTransport.close).toHaveBeenCalledTimes(1);
  });

  it('fails the leaf when the sandbox overlay fails', async () => {
    kubectlTransportMock.mockClear();
    const executeTurn = okTurn();
    selectPoolSandboxMock.mockReset().mockResolvedValue(podLease());
    const r = await runLeaf(env({ configRef: digest }), undefined, {
      executeTurn,
      resolvePromotedConfig: vi.fn(async () => fakePromoted),
      overlayConfig: vi.fn(async () => {
        throw new Error('config overlay failed (exit 1)');
      }),
      // Injected so getBundleRedis() is never reached: without this the test opens a real
      // redis connection, and the resolve/overlay stubs below would never be what fails.
      bundleRedis: {} as never,
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('error');
    expect(executeTurn).not.toHaveBeenCalled();
    // The fallback transport is built for a transport-less (pod) lease even on this failure path,
    // and must still be closed -- it is created inside the try, so only its own local `finally`
    // (not the leaf-level cleanup) is responsible for tearing it down.
    expect(kubectlTransportMock).toHaveBeenCalledTimes(1);
    expect(kubectlTransportMock.mock.results[0]!.value.close).toHaveBeenCalledTimes(1);
  });
});
