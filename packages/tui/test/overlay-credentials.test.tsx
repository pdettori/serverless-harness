import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { CredentialsOverlay } from '../src/views/overlays/Credentials.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

async function type(stdin: { write: (s: string) => void }, ...chunks: string[]) {
  for (const c of chunks) {
    stdin.write(c);
    await tick();
  }
}

describe('CredentialsOverlay', () => {
  it('lists credential metadata, never values', async () => {
    const cp = fakeControlPlane({ listCredentials: async () => [credential('anthropic')] });
    const { lastFrame } = render(withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />));
    await waitFor(() => (lastFrame() ?? '').includes('anthropic'), 1000, lastFrame);
    expect(lastFrame()).toContain('anthropic');
    expect(lastFrame()).toContain('bearer · inference · https://anthropic.example/v1');
  });

  it('adds a credential and returns to the list', async () => {
    const put = vi.fn(async () => undefined);
    const onChanged = vi.fn();
    const cp = fakeControlPlane({ putCredential: put });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onChanged={onChanged} onCancel={vi.fn()} />),
    );
    // Initial SelectList mounts once listCredentials() resolves; wait for its content and for
    // useInput to attach before the first write (see test/helpers/ink.ts).
    await waitFor(
      () => (lastFrame() ?? '').includes('no credentials yet') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('a');
    // 'a' swaps the list for a freshly-mounted Form; wait for its heading and its own
    // useInput attach before typing into it.
    await waitFor(
      () => (lastFrame() ?? '').includes('Add credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    // name, kind (default), consumer (default), hosts (skip), endpoint (skip), token
    await type(
      stdin,
      'mine',
      KEY.enter,
      KEY.enter,
      KEY.enter,
      KEY.enter,
      KEY.enter,
      'sk-1',
      KEY.enter,
    );
    await waitFor(() => (lastFrame() ?? '').includes('Credentials'), 1000, lastFrame);
    expect(put).toHaveBeenCalledWith('mine', {
      kind: 'bearer',
      consumer: 'inference',
      destination: { hosts: [] },
      secret: { token: 'sk-1' },
    }); // notsecret
    expect(put).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Credentials');
  });

  it('shows the server validation message inside the form', async () => {
    const cp = fakeControlPlane({
      putCredential: async () => {
        throw new ApiError(
          'control-plane',
          400,
          'invalid_request',
          "kind 'bearer' requires secret fields: token",
        );
      },
    });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} startInAdd onCancel={vi.fn()} />),
    );
    // startInAdd renders the Form on the very first commit, but its useInput still attaches on
    // its own effect-flush schedule.
    await waitFor(
      () => (lastFrame() ?? '').includes('Add credential') && inputReady(stdin),
      1000,
      lastFrame,
    );
    await type(
      stdin,
      'mine',
      KEY.enter,
      KEY.enter,
      KEY.enter,
      KEY.enter,
      KEY.enter,
      'x',
      KEY.enter,
    );
    await waitFor(
      () => (lastFrame() ?? '').includes("kind 'bearer' requires secret fields: token"),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain("kind 'bearer' requires secret fields: token");
  });

  it('deletes after confirmation', async () => {
    const del = vi.fn(async () => undefined);
    const cp = fakeControlPlane({
      listCredentials: async () => [credential('old')],
      deleteCredential: del,
    });
    const { stdin, lastFrame } = render(
      withTheme(<CredentialsOverlay cp={cp} onCancel={vi.fn()} />),
    );
    await waitFor(() => (lastFrame() ?? '').includes('old') && inputReady(stdin), 1000, lastFrame);
    stdin.write('d');
    // 'd' swaps the list for a freshly-mounted Confirm; wait for its prompt and its own
    // useInput attach before writing 'y'.
    await waitFor(
      () => (lastFrame() ?? '').includes('Delete credential "old"?') && inputReady(stdin),
      1000,
      lastFrame,
    );
    stdin.write('y');
    await waitFor(() => del.mock.calls.length > 0, 1000, lastFrame);
    expect(del).toHaveBeenCalledWith('old');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('shows the contextual hint it was opened with', async () => {
    const { lastFrame } = render(
      withTheme(
        <CredentialsOverlay
          cp={fakeControlPlane()}
          hint="add an inference credential to start"
          onCancel={vi.fn()}
        />,
      ),
    );
    await waitFor(
      () => (lastFrame() ?? '').includes('add an inference credential to start'),
      1000,
      lastFrame,
    );
    expect(lastFrame()).toContain('add an inference credential to start');
  });
});
