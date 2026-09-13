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

`/profile` returns the four resolved values above (`ttftMs`, `tokenDelayMs`, `outputTokens`,
`toolCallRate`) as JSON, AS RESOLVED AT BOOT after defaulting — never the raw env, which may be
unset. This is a separate route from `/health`, which stays a literal `ok` and proves nothing
about which profile is actually running. Final review fix, part 3: a driver's own `SH_STUB_*`
environment has no causal connection to a stub process that is already running with its own env
from its own boot — `/profile` is the only way to verify what a given stub instance is actually
configured with, and both E8's and E9's drivers fetch it from the stub they are actually driving
rather than ever reading their own environment for this.

## Running it

**Locally (VM arm):**

```bash
podman build -t dev.local/model-stub:p6 deploy/knative/model-stub
podman run --rm -d --name p6-stub -p 18081:8080 \
  -e SH_STUB_TTFT_MS=250 -e SH_STUB_TOKEN_DELAY_MS=15 \
  -e SH_STUB_OUTPUT_TOKENS=64 -e SH_STUB_TOOL_CALL_RATE=0.07 \
  dev.local/model-stub:p6
export ANTHROPIC_API_KEY=unused  # notsecret
```

Wiring `ANTHROPIC_BASE_URL` depends on how the VM arm's supervisor is actually running:

- **Foreground / ad hoc** (e.g. `node packages/supervisor/dist/index.js` in a shell you control):
  `export ANTHROPIC_BASE_URL=http://127.0.0.1:18081` in that same shell before starting it works,
  because the supervisor reads it from its own process environment at its own boot, same as any
  other env var.
- **systemd-managed** (the documented production path, `deploy/vm/systemd/sh-supervisor.service`):
  a plain `export` in an interactive shell does **not** reach it — systemd starts the unit in its
  own environment, not yours. The supervisor's env comes from
  `/etc/serverless-harness/supervisor.env` (see `deploy/vm/env/supervisor.env.example`); set
  `ANTHROPIC_BASE_URL` there and `systemctl restart sh-supervisor` (or the project's equivalent
  reload) for it to take effect. This is the same file `e9-tiers.sh`'s pin-2 check reads back via
  `/metrics` to verify the pins actually took, rather than trusting that an `export` somewhere
  reached the process it was meant for.

Either way, the supervisor then picks up `ANTHROPIC_BASE_URL` the same way it would for a real
gateway (see `harness/src/run-turn.ts`); no other wiring is needed. A non-empty
`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) must still be exported even against this stub —
pi-fork's client construction throws "No API key for provider" on an empty one — even though the
stub itself never checks auth at all; any placeholder value works.

**On a cluster (Knative arm):** build and load/push the same image, then point a Knative
Service or a plain Deployment+Service at it and set `ANTHROPIC_BASE_URL` (or
`SH_MODEL_BASE_URL`) on the harness's Service/Revision to
`http://model-stub.<namespace>.svc.cluster.local` (or the Knative Service's cluster-local URL).
This mirrors how `deploy/knative/echo-target.yaml` is wired and how `README-k8s.md` /
`README-kind.md` point the harness at a self-hosted model endpoint.

### Two instances, one per arm — never one shared stub (§5.3, final review fix part 3, item A4)

E9 runs **two separate stub processes**, one co-located with the VM arm (as above) and one
co-located with the Knative arm (in-cluster, as above) — not one shared instance reached over two
different network paths. The model tier is a config property (the four env values a stub
resolves at its own boot), not a network location, and a single shared instance would let the two
arms differ in SSE-per-flush round-trip time for a reason that has nothing to do with the
deployment tier under comparison — whichever arm is farther from the shared stub pays extra
per-flush RTT for every one of the tens of streamed deltas in a turn, not once per turn. It also
does not match how a stub is actually deployed in front of a real gateway: co-located with its
consumer, never centralised.

Both instances **must** run the identical image with the identical resolved env profile — that is
what makes the tier comparison mean anything. `e9-tiers.sh` verifies this itself, at run time, by
comparing what each instance's own `/profile` route reports (see above) and hard-failing, naming
the differing field(s), on any mismatch — not by comparing the two stub URLs or grepping for a
shared string, since with two instances there is no longer one shared string to find. E6's
numbers were taken against a real model and are not comparable to stub-driven ones, which is why
E9 re-runs the Knative arm against its own co-located stub rather than reusing E6's numbers.

## The profile is half the claim (§5.7)

A run whose stub profile (TTFT, token delay, output tokens, and tool-call rate) was not recorded
alongside its result is not a result — it is an unverifiable number. Every E8/E9 run record must
name the four env values the stub was launched with, and the duty-basis row (§2.3) that the
tool-call rate was calibrated from (see `deploy/knative/EXPERIMENTS.md`). Without that, a knee or
a density figure cannot be reproduced or audited later, and two runs that look comparable might
silently have driven different load.
