import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { App, CLEAR_SCREEN, initialOverlay } from '../src/app.js';
import { loadConfig, saveAuth } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';
import { json } from './helpers/fake-fetch.js';
import { credential, doneFrame, fakeControlPlane, fakeHarness } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor } from './helpers/ink.js';
import { fakeOs, testRuntime } from './helpers/runtime.js';

const opts = { setup: false, noAnimation: true };

function mount(rt: Runtime, over: Partial<typeof opts> = {}) {
  const write = vi.fn();
  const os = fakeOs();
  const r = render(<App rt={rt} opts={{ ...opts, ...over }} env={{}} os={os} write={write} />);
  const all = () => r.frames.join('\n');
  const frame = () => r.lastFrame() ?? '';
  const until = (cond: () => boolean, ms = 1500) => waitFor(cond, ms, r.lastFrame);
  // The chat input is ready once its placeholder is painted and Ink is listening to stdin.
  const ready = () => until(() => inputReady(r.stdin) && frame().includes('type a message'));
  return { ...r, write, os, all, frame, until, ready };
}

async function send(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(KEY.enter);
  await tick();
}

describe('initialOverlay', () => {
  it('chooses onboarding, then login, then nothing', () => {
    expect(initialOverlay(testRuntime({ endpoints: {} }), opts)).toEqual({ name: 'onboarding' });
    expect(initialOverlay(testRuntime(), { ...opts, setup: true })).toEqual({ name: 'onboarding' });
    expect(initialOverlay(testRuntime({ auth: null }), opts)).toEqual({ name: 'login' });
    expect(initialOverlay(testRuntime(), opts)).toBeUndefined();
  });
});

describe('App', () => {
  it('opens onboarding on a first run', () => {
    expect(mount(testRuntime({ endpoints: {} })).lastFrame()).toContain('Welcome to sh-tui');
  });

  it('onboarding persists the endpoints it connected to and moves on', async () => {
    const rt = testRuntime({
      endpoints: {},
      config: { ...testRuntime().config, controlPlaneUrl: undefined, harnessUrl: undefined },
      // setEndpoints rewires real clients on this fetch.
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/healthz' || path === '/health') return json({ ok: true });
        if (path === '/v1/credentials') return json({ credentials: [credential('anthropic')] });
        return json({ error: 'internal_error' }, 500);
      }) as typeof fetch,
    });
    // A login already cached for the new control plane, so onboarding skips its login step.
    saveAuth(rt.paths, { ...rt.auth!, controlPlaneUrl: 'http://cp2' });
    const { stdin, frame, until } = mount(rt);
    await until(() => inputReady(stdin) && frame().includes('Control plane URL'));
    stdin.write('http://cp2');
    await tick();
    stdin.write(KEY.enter);
    await tick();
    stdin.write('http://h2/');
    await tick();
    stdin.write(KEY.enter);
    await until(() => frame().includes('New session'));
    expect(loadConfig(rt.paths).config).toMatchObject({
      controlPlaneUrl: 'http://cp2',
      harnessUrl: 'http://h2',
    });
    expect(rt.endpoints).toEqual({ controlPlaneUrl: 'http://cp2', harnessUrl: 'http://h2' });
    // createSession fails (500): the error screen has no input of its own, and Esc still closes it.
    await until(() => frame().includes('unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('New session') && frame().includes('type a message'));
  });

  it('opens login when the cached login is missing', async () => {
    const { frame, until } = mount(testRuntime({ auth: null }));
    await until(() => frame().includes('Log in with GitHub'));
  });

  it('a first message creates a session and streams the reply', async () => {
    const rt = testRuntime({
      harness: fakeHarness([
        {
          frames: [
            { type: 'text', delta: 'Hello ' },
            { type: 'text', delta: 'world' },
            doneFrame('s-new'),
          ],
        },
      ]),
    });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi there');
    await until(() => all().includes('Hello world'));
    const calls = (rt.cp as unknown as { calls: string[] }).calls;
    expect(calls.filter((c) => c === 'createSession')).toHaveLength(1);
    expect((rt.harness as unknown as { turns: unknown[] }).turns).toHaveLength(1);
    expect(all()).toContain('› hi there');
    expect(frame()).toContain('hi there'); // the auto title, in the status line
    expect(loadConfig(rt.paths).config.lastUsed).toEqual({ inferenceCredential: 'anthropic' });
  });

  it('runs slash commands and reports unknown ones', async () => {
    const rt = testRuntime();
    const { stdin, frame, write, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/details');
    await until(() => rt.config.details === true);
    expect(loadConfig(rt.paths).config.details).toBe(true);
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN);
    await send(stdin, '/frobnicate');
    await until(() => frame().includes('unknown command /frobnicate'));
  });

  it('/thinking and /theme persist to config.json and redraw', async () => {
    const rt = testRuntime();
    const { stdin, frame, write, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/thinking');
    await until(() => loadConfig(rt.paths).config.thinking === false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(CLEAR_SCREEN);
    await send(stdin, '/theme');
    await until(() => frame().includes('theme: dark'));
    expect(loadConfig(rt.paths).config.theme).toBe('dark');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('opens the sessions overlay with the ctrl+x l leader chord', async () => {
    const { stdin, frame, until, ready } = mount(testRuntime());
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => frame().includes('Sessions'));
  });

  it('Esc cancels a running turn', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'thinking hard' }], hang: true }]),
    });
    const { stdin, all, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'long task');
    await until(() => all().includes('thinking hard'));
    stdin.write(KEY.escape);
    await until(() => all().includes('cancelled'));
  });

  it('a second Esc within a second also clears the queue', async () => {
    const rt = testRuntime({
      harness: fakeHarness([
        { frames: [{ type: 'text', delta: 'first' }], hang: true },
        { frames: [{ type: 'text', delta: 'second' }], hang: true },
      ]),
    });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'one');
    await until(() => all().includes('first'));
    await send(stdin, 'two');
    await send(stdin, 'three');
    await until(() => frame().includes('queued: 2'));
    stdin.write(KEY.escape);
    await until(() => all().includes('second'));
    stdin.write(KEY.escape);
    await until(() => frame().includes('queue cleared'));
    await until(() => frame().includes('idle'));
    // 'three' was dropped: only two turns ever reached the harness.
    expect((rt.harness as unknown as { turns: unknown[] }).turns).toHaveLength(2);
  });

  it('resuming a session with no local history says so', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => ({
        sessions: [
          {
            sessionId: 'remote-1',
            owner: 'github:1',
            tenant: 't',
            createdAt: 0,
            state: 'active',
            lastTurnAt: null,
            turns: 3,
          },
        ],
        nextCursor: null,
      }),
    });
    const { stdin, all, write, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => inputReady(stdin) && frame().includes('remote-1'));
    await tick();
    stdin.write(KEY.enter);
    await until(() => all().includes("isn't available on this device"));
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN);
    expect(cp.calls.filter((c) => c === 'mintSessionToken')).toHaveLength(1);
  });

  it('Esc closes an overlay stuck on an error screen', async () => {
    const cp = fakeControlPlane({
      listSessions: async () => {
        throw new ApiError('control-plane', 503, 'redis_unavailable');
      },
    });
    const { stdin, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    stdin.write(KEY.ctrl('x'));
    await tick();
    stdin.write('l');
    await until(() => frame().includes('control plane is unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('control plane is unavailable'));
    expect(frame()).toContain('type a message');
  });

  it('Esc closes the credentials overlay from its error screen', async () => {
    const cp = fakeControlPlane({
      listCredentials: async () => {
        throw new ApiError('control-plane', 503, 'redis_unavailable');
      },
    });
    const { stdin, frame, until, ready } = mount(testRuntime({ cp }));
    await ready();
    await send(stdin, '/credentials');
    await until(() => frame().includes('control plane is unavailable'));
    stdin.write(KEY.escape);
    await until(() => !frame().includes('control plane is unavailable'));
  });

  it('diagnoses an untrusted harness instead of asking to log in again', async () => {
    const bad = new ApiError('harness', 401, 'token_invalid');
    const { stdin, frame, until, ready } = mount(
      testRuntime({ harness: fakeHarness([{ error: bad }, { error: bad }]) }),
    );
    await ready();
    await send(stdin, 'hi');
    await until(() => frame().includes('run /doctor'));
    expect(frame()).not.toContain('Log in with GitHub');
  });

  it('opens login when the API token expires mid-session, then re-sends the prompt', async () => {
    let mints = 0;
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('anthropic')],
      mintSessionToken: async () => {
        mints++;
        throw new ApiError('control-plane', 401, 'token_expired');
      },
      pollDeviceAuth: async () => ({
        token: 'a2',
        subject: 'github:1',
        displayName: 'Ada',
        expiresAt: 4_000_000_000,
      }),
    });
    const harness = fakeHarness([
      { error: new ApiError('harness', 401, 'token_expired') },
      { frames: [{ type: 'text', delta: 'replayed' }, doneFrame('s-new')] },
    ]);
    const rt = testRuntime({ cp, harness });
    const { stdin, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi');
    await until(() => frame().includes('Log in with GitHub'));
    expect(mints).toBe(1);
    // The device flow completes (pollDeviceAuth approves on the first poll).
    await until(() => all().includes('replayed'));
    expect(rt.auth?.apiToken).toBe('a2');
    expect(harness.turns.map((t) => t.prompt)).toEqual(['hi', 'hi']);
  });

  it('rings the bell when a turn ends after 10 s of input idleness', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = fakeHarness([], {
      async *streamTurn() {
        await gate;
        yield doneFrame('s-new');
      },
    });
    const { stdin, write, frame, until, ready } = mount(testRuntime({ harness, now: () => clock }));
    await ready();
    await send(stdin, 'slow one');
    await until(() => frame().includes('waiting for harness'));
    clock += 11_000;
    release();
    await until(() => write.mock.calls.some(([s]) => s === '\u0007'));
  });

  it('does not ring the bell when the input was used recently', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = fakeHarness([], {
      async *streamTurn() {
        await gate;
        yield doneFrame('s-new');
      },
    });
    const { stdin, write, frame, until, ready } = mount(testRuntime({ harness, now: () => clock }));
    await ready();
    await send(stdin, 'slow one');
    await until(() => frame().includes('waiting for harness'));
    clock += 11_000;
    stdin.write('x'); // typing, not submitting, still counts as input activity
    await tick();
    release();
    await until(() => frame().includes('idle'));
    expect(write.mock.calls.some(([s]) => s === '\u0007')).toBe(false);
  });

  it('copies the last reply through the OS clipboard', async () => {
    const rt = testRuntime({
      harness: fakeHarness([{ frames: [{ type: 'text', delta: 'copy me' }, doneFrame('s-new')] }]),
    });
    const { stdin, os, all, frame, until, ready } = mount(rt);
    await ready();
    await send(stdin, 'hi');
    await until(() => all().includes('copy me') && frame().includes('idle'));
    await send(stdin, '/copy');
    await until(() => os.copy.mock.calls.length > 0);
    expect(os.copy).toHaveBeenCalledTimes(1);
    expect(os.copy).toHaveBeenCalledWith('copy me');
  });

  it('shows a toast instead of crashing when the editor cannot start', async () => {
    const rt = testRuntime();
    const { stdin, os, frame, until, ready } = mount(rt);
    os.editText.mockImplementation(() => {
      throw new Error('could not start editor "nope": command not found (exit 127)');
    });
    await ready();
    await send(stdin, '/editor');
    await until(() => frame().includes('could not start editor'));
    expect(frame()).toContain('type a message');
  });

  it('sends what was composed in the editor', async () => {
    const rt = testRuntime();
    const { stdin, all, until, ready } = mount(rt);
    await ready();
    await send(stdin, '/editor');
    await until(() => all().includes('› from the editor'));
  });
});
