# model-stub

An Anthropic-compatible SSE model stub for P6's E8 (VM density) and E9 (VM vs. Knative)
experiments (spec §5.4). It streams `POST /v1/messages` responses shaped like the real
Anthropic Messages API — `message_start` / `content_block_start` / `content_block_delta` /
`content_block_stop` / `message_delta` / `message_stop` — with a configurable
time-to-first-token, inter-token delay, output length, and (unlike a plain echo target) a
**tool-call rate**: on a deterministic schedule it emits a `tool_use` block instead of text, so
sessions actually reach the sandbox tier during a run. A stub that only streamed text would make
E8's density number silently exclude the entire hands tier.

Dependency-free CommonJS on `node:http`, matching `../echo-target/echo.js`.

## Env knobs

| Var                      | Default                           | Meaning                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SH_STUB_TTFT_MS`        | `300`                             | Delay before the first content byte of each turn (ms).                                                                                                                                                                                                                    |
| `SH_STUB_TOKEN_DELAY_MS` | `12`                              | Delay between each streamed delta (ms).                                                                                                                                                                                                                                   |
| `SH_STUB_OUTPUT_TOKENS`  | `64`                              | Number of `text_delta` chunks for a text-only turn.                                                                                                                                                                                                                       |
| `SH_STUB_TOOL_CALL_RATE` | `0.07`                            | Fraction of turns that emit a `tool_use` block instead of text, in `[0, 1]`. Realised deterministically as "every Nth turn" (`N = round(1 / rate)`), not a per-turn coin flip — an E8 rung is tens of turns, too few for a Bernoulli draw to land on the configured rate. |
| `SH_STUB_TOOL_NAME`      | `bash`                            | Tool name carried on the `tool_use` block (must be a tool the harness can actually dispatch).                                                                                                                                                                             |
| `SH_STUB_TOOL_INPUT`     | `{"command":"ls -la /workspace"}` | Raw JSON string streamed as `input_json_delta` fragments.                                                                                                                                                                                                                 |
| `PORT`                   | `8080`                            | Bind port. `PORT=0` binds an ephemeral port; the process logs the bound port on the `model-stub listening :<port>` line.                                                                                                                                                  |

An out-of-range `SH_STUB_TOOL_CALL_RATE` (outside `[0, 1]`) or a non-numeric value for any of
these fails at boot (`process.exit(2)` with a message naming the offending var) rather than
silently clamping. A clamped value would make the recorded profile a lie, and that record is the
only thing that makes a density number auditable after the run.

`/health` and `/healthz` both return `200 ok` for a Knative readiness probe or
`deploy/vm/setup-vm.sh`.

## Running it

**Locally (VM arm):**

```bash
podman build -t dev.local/model-stub:p6 deploy/knative/model-stub
podman run --rm -d --name p6-stub -p 18081:8080 \
  -e SH_STUB_TTFT_MS=250 -e SH_STUB_TOKEN_DELAY_MS=15 \
  -e SH_STUB_OUTPUT_TOKENS=64 -e SH_STUB_TOOL_CALL_RATE=0.07 \
  dev.local/model-stub:p6
export ANTHROPIC_BASE_URL=http://127.0.0.1:18081
```

The VM arm's supervisor picks up `ANTHROPIC_BASE_URL` the same way it would for a real gateway
(see `harness/src/run-turn.ts`); no other wiring is needed.

**On a cluster (Knative arm):** build and load/push the same image, then point a Knative
Service or a plain Deployment+Service at it and set `ANTHROPIC_BASE_URL` (or
`SH_MODEL_BASE_URL`) on the harness's Service/Revision to
`http://model-stub.<namespace>.svc.cluster.local` (or the Knative Service's cluster-local URL).
This mirrors how `deploy/knative/echo-target.yaml` is wired and how `README-k8s.md` /
`README-kind.md` point the harness at a self-hosted model endpoint.

Both E9 arms **must** run the identical image with the identical env profile — that is what
makes the tier comparison mean anything (§5.3). E6's numbers were taken against a real model and
are not comparable to stub-driven ones, which is why E9 re-runs the Knative arm against this
stub rather than reusing E6's numbers.

## The profile is half the claim (§5.7)

A run whose stub profile (TTFT, token delay, output tokens, and tool-call rate) was not recorded
alongside its result is not a result — it is an unverifiable number. Every E8/E9 run record must
name the four env values the stub was launched with, and the duty-basis row (§2.3) that the
tool-call rate was calibrated from (see `deploy/knative/EXPERIMENTS.md`). Without that, a knee or
a density figure cannot be reproduced or audited later, and two runs that look comparable might
silently have driven different load.
