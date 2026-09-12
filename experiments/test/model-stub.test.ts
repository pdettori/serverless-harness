import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('../../deploy/knative/model-stub/stub.js', import.meta.url));

let child: ChildProcess | undefined;
let base = '';

/** Boot the stub on an ephemeral port with a fast profile, and wait for its ready line. */
async function boot(env: Record<string, string>): Promise<void> {
  child = spawn(process.execPath, [STUB], {
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stub did not report a port')), 5000);
    child!.stdout!.on('data', (b: Buffer) => {
      // The stub must print its bound port, because PORT=0 means the test cannot know it.
      const m = /listening :(\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
  base = `http://127.0.0.1:${port}`;
}

/** POST a messages request and return the raw SSE text. */
async function stream(body: unknown): Promise<string> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'stub' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return await res.text();
}

const REQ = { model: 'stub', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };

afterAll(() => {
  child?.kill('SIGTERM');
});

describe('model stub — SSE shape', () => {
  beforeAll(async () => {
    await boot({
      SH_STUB_TTFT_MS: '5',
      SH_STUB_TOKEN_DELAY_MS: '1',
      SH_STUB_OUTPUT_TOKENS: '6',
      SH_STUB_TOOL_CALL_RATE: '0', // text-only for the shape test
    });
  });

  it('streams a well-formed Anthropic message with the configured token count', async () => {
    const sse = await stream(REQ);
    for (const ev of [
      'event: message_start',
      'event: content_block_start',
      'event: content_block_delta',
      'event: content_block_stop',
      'event: message_delta',
      'event: message_stop',
    ]) {
      expect(sse).toContain(ev);
    }
    // Every data: line must be valid JSON — a client parses these, not a human.
    const datas = [...sse.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!));
    expect(datas.length).toBeGreaterThan(0);
    expect(datas.filter((d) => d.type === 'content_block_delta')).toHaveLength(6);
    expect(sse.endsWith('\n\n')).toBe(true);
  });

  it('answers /health so a Knative readiness probe and setup-vm.sh can both use it', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe('model stub — tool-call profile (§5.4)', () => {
  beforeAll(async () => {
    child?.kill('SIGTERM');
    await boot({
      SH_STUB_TTFT_MS: '1',
      SH_STUB_TOKEN_DELAY_MS: '0',
      SH_STUB_OUTPUT_TOKENS: '2',
      SH_STUB_TOOL_CALL_RATE: '0.25',
    });
  });

  it('emits a tool_use block at the configured rate, deterministically', async () => {
    // A Bernoulli draw at p=0.25 would put the realised rate anywhere from 0.1 to 0.4 over 20
    // turns, and an E8 rung is tens of turns — so a "calibrated" stub would drive whatever duty
    // the RNG felt like. Every 4th turn is exact at the scale we actually measure.
    const results: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      results.push((await stream(REQ)).includes('"type":"tool_use"'));
    }
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('a tool_use block names a tool the harness can actually run and carries valid input', async () => {
    // A tool call the harness cannot dispatch produces an error turn, not a sandbox visit —
    // which is exactly the "density number excludes the hands tier" failure with extra steps.
    let sse = '';
    for (let i = 0; i < 8 && !sse.includes('tool_use'); i += 1) sse = await stream(REQ);
    const blocks = [...sse.matchAll(/^data: (.*)$/gm)]
      .map((m) => JSON.parse(m[1]!))
      .filter((d) => d.type === 'content_block_start' && d.content_block?.type === 'tool_use');
    expect(blocks).toHaveLength(1);
    expect(typeof blocks[0].content_block.name).toBe('string');
    expect(blocks[0].content_block.name.length).toBeGreaterThan(0);
    // input_json_delta fragments must concatenate to parseable JSON.
    const json = [...sse.matchAll(/^data: (.*)$/gm)]
      .map((m) => JSON.parse(m[1]!))
      .filter((d) => d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta')
      .map((d) => d.delta.partial_json)
      .join('');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('a tool-call turn stops with stop_reason tool_use', async () => {
    let sse = '';
    for (let i = 0; i < 8 && !sse.includes('tool_use'); i += 1) sse = await stream(REQ);
    expect(sse).toContain('"stop_reason":"tool_use"');
  });

  it('rejects a tool-call rate outside [0,1] at boot rather than serving a wrong duty', async () => {
    // A typo'd rate that silently clamps would make a run's recorded profile a lie, and the
    // record is the only thing that makes the number auditable later.
    const bad = spawn(process.execPath, [STUB], {
      env: { ...process.env, PORT: '0', SH_STUB_TOOL_CALL_RATE: '7' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const [code, err] = await new Promise<[number | null, string]>((resolve) => {
      let e = '';
      bad.stderr!.on('data', (b: Buffer) => (e += b.toString()));
      bad.on('exit', (c) => resolve([c, e]));
    });
    expect(code).not.toBe(0);
    expect(err).toMatch(/SH_STUB_TOOL_CALL_RATE/);
  });
});

describe('model stub — timing profile', () => {
  it('honours time-to-first-token', async () => {
    child?.kill('SIGTERM');
    await boot({
      SH_STUB_TTFT_MS: '250',
      SH_STUB_TOKEN_DELAY_MS: '0',
      SH_STUB_OUTPUT_TOKENS: '1',
      SH_STUB_TOOL_CALL_RATE: '0',
    });
    const t0 = Date.now();
    await stream(REQ);
    // TTFT is what E8's p95 is mostly made of at low concurrency; if the knob does nothing,
    // every rung measures the harness's overhead against a zero-latency model, which is not a
    // workload any provisioning rule should be derived from.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });
});
