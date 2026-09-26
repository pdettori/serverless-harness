import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { SessionManager, type ActiveSession } from '../src/core/session-manager.js';
import { EMPTY_BLOCKS } from '../src/render/blocks.js';
import { useSession, type SessionView } from '../src/views/useSession.js';
import { doneFrame, fakeControlPlane, fakeHarness, type HarnessStep } from './helpers/fakes.js';
import { tick } from './helpers/ink.js';

let clock = 0;
const now = () => clock;

async function mount(steps: HarnessStep[]) {
  const manager = new SessionManager({
    cp: fakeControlPlane(),
    harness: fakeHarness(steps),
    now,
    sleep: async () => undefined,
  });
  const session = await manager.resume('s1');
  const view: { current?: SessionView } = {};
  function Probe({ s }: { s: ActiveSession }) {
    view.current = useSession(s, { initial: EMPTY_BLOCKS, now });
    return <Text>{view.current.turn.phase}</Text>;
  }
  render(<Probe s={session} />);
  await tick();
  return view as { current: SessionView };
}

describe('useSession', () => {
  it('turns a streamed turn into blocks, coalescing deltas, and records usage', async () => {
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
    const deltas = Array.from({ length: 50 }, (_, i) => ({
      type: 'text' as const,
      delta: String(i % 10),
    }));
    const view = await mount([{ frames: [...deltas, { ...doneFrame(), usage }] }]);
    view.current.submit('hi');
    await tick(120);
    const blocks = view.current.state.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'turn-end']);
    expect((blocks[1] as { text: string }).text).toBe('0123456789'.repeat(5));
    expect(view.current.turn.phase).toBe('idle');
    expect(view.current.turn.lastTtftMs).toBeDefined();
    expect(view.current.usage).toMatchObject({ input: 10, output: 5 });
    expect(view.current.lastReply()).toBe('0123456789'.repeat(5));
  });

  it('marks a prompt submitted mid-turn as queued, then sends it after a cancel', async () => {
    const view = await mount([{ frames: [{ type: 'text', delta: 'working' }], hang: true }]);
    view.current.submit('a');
    await tick(60);
    expect(view.current.turn.phase).toBe('streaming');
    view.current.submit('b');
    await tick();
    expect(view.current.state.blocks.at(-1)).toMatchObject({
      kind: 'user',
      text: 'b',
      queued: true,
    });
    expect(view.current.turn.queued).toBe(1);
    view.current.cancel();
    await tick(120);
    const kinds = view.current.state.blocks.map((b) =>
      b.kind === 'turn-end' ? `end:${b.outcome}` : b.kind,
    );
    expect(kinds).toEqual(['user', 'assistant', 'end:cancelled', 'user', 'end:done']);
    expect(view.current.state.blocks[3]).toMatchObject({ queued: false });
  });

  it('clearQueue drops queued prompts from the transcript', async () => {
    const view = await mount([{ hang: true }]);
    view.current.submit('a');
    await tick();
    view.current.submit('b');
    await tick();
    view.current.clearQueue();
    view.current.cancel();
    await tick(120);
    expect(
      view.current.state.blocks
        .filter((b) => b.kind === 'user')
        .map((b) => (b as { text: string }).text),
    ).toEqual(['a']);
  });

  it('shows a transport failure as an error turn-end', async () => {
    const { ApiError } = await import('../src/api/errors.js');
    const view = await mount([
      { error: new ApiError('harness', 0, 'network_error', 'ECONNRESET') },
    ]);
    view.current.submit('a');
    await tick(120);
    expect(view.current.state.blocks.at(-1)).toMatchObject({
      kind: 'turn-end',
      outcome: 'error',
      message: 'cannot reach the harness: ECONNRESET',
    });
  });
});
