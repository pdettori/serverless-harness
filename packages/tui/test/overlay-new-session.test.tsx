import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionOverlay } from '../src/views/overlays/NewSession.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { KEY, pressUntil, tick, withTheme } from './helpers/ink.js';

const cpWith = (...names: string[]) =>
  fakeControlPlane({ listCredentials: async () => names.map((n) => credential(n)) });

function setup(cp = cpWith('a'), over: Partial<Parameters<typeof NewSessionOverlay>[0]> = {}) {
  const onCreate = vi.fn(() => new Promise<void>(() => undefined));
  const onBlocked = vi.fn();
  const r = render(
    withTheme(
      <NewSessionOverlay
        cp={cp}
        lastUsed={{}}
        presets={[]}
        onCreate={onCreate}
        onBlocked={onBlocked}
        onCancel={vi.fn()}
        {...over}
      />,
    ),
  );
  return { ...r, onCreate, onBlocked };
}

describe('NewSessionOverlay', () => {
  it('creates straight away with a single credential', async () => {
    const { onCreate, lastFrame } = setup();
    await tick();
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'a' } },
      { inferenceCredential: 'a' },
    );
    expect(lastFrame()).toContain('creating session');
  });

  it('routes to credentials when there is none', async () => {
    const { onBlocked } = setup(cpWith());
    await tick();
    expect(onBlocked).toHaveBeenCalledWith('add an inference credential to start');
  });

  it('asks when there are several, preselecting the last used', async () => {
    const { stdin, onCreate, lastFrame } = setup(cpWith('a', 'b'), {
      lastUsed: { inferenceCredential: 'b' },
    });
    await tick();
    expect(lastFrame()).toContain('Inference credential');
    // The just-resolved SelectList's useInput effect subscribes asynchronously after this paint,
    // and under load that lag isn't reliably bounded by a small fixed number of ticks (see the
    // helper's doc comment). Resending Enter — harmless once onCreate has already fired — until
    // it visibly takes effect rides out that lag instead of guessing a settle time.
    await pressUntil(stdin.write, KEY.enter, () => onCreate.mock.calls.length > 0);
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'b' } },
      { inferenceCredential: 'b' },
    );
  });

  it('uses a preset, and notes preset fields the client no longer knows', async () => {
    const { stdin, onCreate, lastFrame } = setup(cpWith('a', 'b'), {
      presets: [{ name: 'work', values: { inferenceCredential: 'b', model: 'opus' } }],
    });
    await tick();
    expect(lastFrame()).toContain('work');
    // See the comment in the "asks when there are several" test above: retry rather than guess
    // a settle time.
    await pressUntil(stdin.write, KEY.enter, () => onCreate.mock.calls.length > 0);
    expect(onCreate).toHaveBeenCalledWith(
      { credentials: { inference: 'b' } },
      { inferenceCredential: 'b' },
    );
    expect(lastFrame()).toContain('ignoring preset fields this version does not know: model');
  });

  it('shows a creation error', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('credential_required');
    });
    const { lastFrame } = setup(cpWith('a'), { onCreate });
    await tick();
    expect(lastFrame()).toContain('credential_required');
  });
});
