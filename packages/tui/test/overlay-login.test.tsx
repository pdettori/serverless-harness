import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { LoginOverlay } from '../src/views/overlays/Login.js';
import { fakeControlPlane } from './helpers/fakes.js';
import { KEY, pressUntil, tick, withTheme } from './helpers/ink.js';

const waitForAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));

describe('LoginOverlay', () => {
  it('shows the code and URL, and copies the code on c', async () => {
    const copy = vi.fn();
    const deps = { cp: fakeControlPlane(), now: () => 0, sleep: waitForAbort };
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={deps}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
          copy={copy}
        />,
      ),
    );
    await tick();
    expect(lastFrame()).toContain('ABCD-1234');
    expect(lastFrame()).toContain('https://github.com/login/device');
    expect(lastFrame()).toContain('code expires in 15m00s');
    // LoginOverlay's useInput subscribes in a useEffect that flushes asynchronously after this
    // paint; under load that lag isn't reliably bounded by a small fixed number of ticks (see
    // the helper's doc comment). Resending 'c' — harmless once copy has already fired — until it
    // visibly takes effect rides out that lag instead of guessing a settle time.
    await pressUntil(stdin.write, 'c', () => copy.mock.calls.length > 0);
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
  });

  it('reports the login once approved', async () => {
    const onLoggedIn = vi.fn();
    const cp = fakeControlPlane({
      pollDeviceAuth: async () => ({ token: 'api', subject: 'github:1', roles: [], expiresAt: 9 }),
    });
    render(
      withTheme(
        <LoginOverlay
          deps={{ cp, now: () => 0, sleep: async () => undefined }}
          controlPlaneUrl="http://cp"
          onLoggedIn={onLoggedIn}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    expect(onLoggedIn).toHaveBeenCalledWith({
      apiToken: 'api',
      subject: 'github:1',
      roles: [],
      expiresAt: 9,
      controlPlaneUrl: 'http://cp',
      displayName: undefined,
    });
  });

  it('shows an error and retries on r', async () => {
    let starts = 0;
    const cp = fakeControlPlane({
      startDeviceAuth: async () => {
        starts++;
        throw new ApiError('control-plane', 0, 'network_error', 'ECONNREFUSED');
      },
    });
    const { lastFrame, stdin } = render(
      withTheme(
        <LoginOverlay
          deps={{ cp, now: () => 0, sleep: waitForAbort }}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    expect(lastFrame()).toContain('cannot reach the control plane: ECONNREFUSED');
    // See the comment in the "shows the code and URL" test above: retry rather than guess a
    // settle time. Resending 'r' is safe here — a keystroke dropped before the handler
    // subscribes is simply never delivered (no buffering), so only the first one that actually
    // lands increments `starts`.
    await pressUntil(stdin.write, 'r', () => starts >= 2);
    expect(starts).toBe(2);
  });

  it('cancels on Esc', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      withTheme(
        <LoginOverlay
          deps={{ cp: fakeControlPlane(), now: () => 0, sleep: waitForAbort }}
          controlPlaneUrl="http://cp"
          onLoggedIn={vi.fn()}
          onCancel={onCancel}
        />,
      ),
    );
    stdin.write(KEY.escape);
    await tick(80);
    expect(onCancel).toHaveBeenCalled();
  });
});
