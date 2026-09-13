// Anthropic-compatible SSE model stub for P6 E8/E9 (spec §5.4).
//
// Exists so both E9 arms drive an IDENTICAL model tier: E6's numbers were taken against a real
// model and are not comparable to stub-driven ones, so the Knative arm is re-run against this
// via ANTHROPIC_BASE_URL, and the VM arm runs the same image locally.
//
// The tool-call rate is NOT optional. A stub that streams only text means no session ever
// reaches the sandbox, and E8's density number would silently exclude the entire hands tier.
// The rate is calibrated to ONE row of spec §2.3's table (default basis E6/OCP,
// duty 0.061-0.079, documented in deploy/knative/EXPERIMENTS.md) and this plan's own run
// record — deploy/vm/EXPERIMENTS.md (Task 5) — names which row a given run used.
const http = require('http');

const num = (name, fallback, { min, max }) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    // Fail at boot. A clamped value would make the recorded profile a lie, and that record is
    // the only thing that makes the density number auditable after the run.
    console.error(`${name}='${raw}' must be a number in [${min}, ${max}]`);
    process.exit(2);
  }
  return v;
};

const TTFT_MS = num('SH_STUB_TTFT_MS', 300, { min: 0, max: 60000 });
const TOKEN_DELAY_MS = num('SH_STUB_TOKEN_DELAY_MS', 12, { min: 0, max: 10000 });
const OUTPUT_TOKENS = num('SH_STUB_OUTPUT_TOKENS', 64, { min: 1, max: 100000 });
const TOOL_CALL_RATE = num('SH_STUB_TOOL_CALL_RATE', 0.07, { min: 0, max: 1 });
const TOOL_NAME = process.env.SH_STUB_TOOL_NAME || 'bash';
const TOOL_INPUT = process.env.SH_STUB_TOOL_INPUT || '{"command":"ls -la /workspace"}';
const PORT = Number(process.env.PORT || 8080);

// Deterministic every-Nth-turn schedule rather than a per-turn coin flip. At the rates §5.4
// calibrates from (~0.07) a Bernoulli draw needs hundreds of turns to realise the configured
// rate, and an E8 rung is tens — so a "calibrated" stub would drive whatever duty the RNG felt
// like on that rung, which is the same class of error as blending two duty bases.
const EVERY = TOOL_CALL_RATE > 0 ? Math.round(1 / TOOL_CALL_RATE) : 0;
let turns = 0;
const wantsTool = () => EVERY > 0 && turns % EVERY === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, type, data) => {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
};

async function streamMessage(res, useTool) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `msg_stub_${Date.now()}_${turns}`;
  send(res, 'message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'stub',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 0 },
    },
  });
  await sleep(TTFT_MS);

  if (useTool) {
    send(res, 'content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_stub_${turns}`, name: TOOL_NAME, input: {} },
    });
    // Fragment the JSON the way a real stream does, so a client that accumulates
    // input_json_delta is actually exercised.
    const half = Math.ceil(TOOL_INPUT.length / 2);
    for (const part of [TOOL_INPUT.slice(0, half), TOOL_INPUT.slice(half)]) {
      send(res, 'content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: part },
      });
      await sleep(TOKEN_DELAY_MS);
    }
    send(res, 'content_block_stop', { index: 0 });
    send(res, 'message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    send(res, 'message_stop', {});
    res.end();
    return;
  }

  send(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < OUTPUT_TOKENS; i += 1) {
    send(res, 'content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: i === 0 ? 'ok' : ` t${i}` },
    });
    await sleep(TOKEN_DELAY_MS);
  }
  send(res, 'content_block_stop', { index: 0 });
  send(res, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: OUTPUT_TOKENS },
  });
  send(res, 'message_stop', {});
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }
  // Final review fix, part 3, item A: a separate route from /health, deliberately. /health is a
  // liveness probe an orchestrator polls and stays trivial and cheap; /profile is a diagnostic a
  // driver reads ONCE per run so its §5.7 claim sentence can quote what this process was actually
  // launched with, not what the driver's own environment said (those two can differ: this process
  // may have booted minutes or hosts away from whichever shell exported SH_STUB_*). Values here
  // are RESOLVED -- post-defaulting, via the same `num()` helper used to build the consts above --
  // not raw env strings, so a reader cannot tell a set value from an unset one and does not need
  // to.
  if (req.url === '/profile') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        ttftMs: TTFT_MS,
        tokenDelayMs: TOKEN_DELAY_MS,
        outputTokens: OUTPUT_TOKENS,
        toolCallRate: TOOL_CALL_RATE,
      }),
    );
    return;
  }
  if (req.method !== 'POST' || !String(req.url).endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const useTool = wantsTool();
    turns += 1;
    streamMessage(res, useTool).catch(() => {
      // The client hung up mid-stream; nothing to report and nothing to clean up.
      res.destroy();
    });
  });
});

server.listen(PORT, () => {
  // Print the BOUND port, not PORT: tests boot with PORT=0 and have no other way to find it.
  const { port } = server.address();
  console.log(
    `model-stub listening :${port} ttft=${TTFT_MS}ms tokenDelay=${TOKEN_DELAY_MS}ms ` +
      `tokens=${OUTPUT_TOKENS} toolRate=${TOOL_CALL_RATE} (every ${EVERY || 'never'})`,
  );
});
