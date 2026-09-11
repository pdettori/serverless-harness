# Single-VM deployment (P6 process-manager runtime)

Round one's target for the VM process-manager runtime (spec §4.3, §4.4, step 4): a single
Linux VM running the supervisor and relay under systemd, with Redis and the sandbox
containers as podman containers alongside them. `setup-vm.sh` is the sibling of
`deploy/knative/setup-kind.sh` and `deploy/knative/setup-ocp.sh`.

## Prerequisites

- A Linux VM with systemd and [podman](https://podman.io/) installed
- Node.js 22+ and pnpm 9+ on the VM (the supervisor and relay run directly via
  `node --import tsx`, not containerized)
- A user able to install systemd units under `/etc/systemd/system` and run as root (see
  "Bring it up" below)
- A system user and group named `harness` (both units run as `User=harness`/`Group=harness`):
  e.g. `sudo useradd --system --no-create-home --shell /usr/sbin/nologin harness`
- **The workspace built.** `ExecStart=node --import tsx src/main.ts` needs `tsx` (a
  devDependency) and the workspace's `link:` targets resolved, and those only exist after the
  checkout is built. Run, in order (spec §9), once per checkout:

  ```bash
  git submodule update --init --recursive
  cd pi-fork && npm ci && npm run build && cd ..
  pnpm install
  ```

  `setup-vm.sh` checks for this and refuses to continue with a clear message if it is missing —
  it does **not** run the build itself, since it can take minutes and does not belong inside a
  bring-up script.

## Bring it up

```bash
cd /opt/serverless-harness   # this checkout, on the VM, already built (see Prerequisites)
sudo ./deploy/vm/setup-vm.sh
```

That one command — run *after* the build above, not instead of it — does the following:

1. Writes `/etc/serverless-harness/supervisor.env` and `relay.env` from their `env/*.example`
   templates — only the first time each; an operator-edited env file is never clobbered on a
   re-run.
2. Installs `systemd/sh-supervisor.service` and `systemd/sh-relay.service` into
   `/etc/systemd/system` and reloads the daemon.
3. Starts a Redis container and `SH_SANDBOX_COUNT` (default 2) sandbox containers via podman.
4. Enables **and starts** `sh-relay.service`, but only **enables** `sh-supervisor.service` — it
   is deliberately not started yet (see below).

`SH_TURNS_PER_WORKER` ships empty on purpose (see below), and `readConfig` throws on blank, so
the supervisor unit is *expected* to fail if it starts before the operator sets it. With
`Restart=always`/`RestartSec=2` and no `StartLimitIntervalSec=0`, starting it in that state
trips systemd's default 5-starts-in-10s limit in about ten seconds, and the unit then refuses
even the ordinary recovery command until you `systemctl reset-failed` it. `setup-vm.sh` avoids
that entirely by enabling the unit (so it starts on future boots) without starting it now.
Before starting it for the first time, edit `/etc/serverless-harness/supervisor.env` and set
`SH_TURNS_PER_WORKER`, then:

```bash
sudo systemctl start sh-supervisor.service
```

### Troubleshooting: "start request repeated too quickly"

If `sh-supervisor.service` ends up crash-looping anyway (for example, it was started before
`SH_TURNS_PER_WORKER` was set, or some other config problem repeats within the 10-second
window), systemd locks it out with `Failed to start sh-supervisor.service: Unit
sh-supervisor.service is not loaded properly: start request repeated too quickly.` Fix the
underlying config in `supervisor.env`, then clear the lockout and start again:

```bash
sudo systemctl reset-failed sh-supervisor.service
sudo systemctl start sh-supervisor.service
```

## Where the env file lives

`/etc/serverless-harness/supervisor.env` (mode 0640, root-owned — `install_env` runs as
root and does not `chown` to `harness`; that's fine, since systemd reads `EnvironmentFile=`
as PID 1, before dropping privileges to `User=harness`), installed once from
`deploy/vm/env/supervisor.env.example`. `SH_TURNS_PER_WORKER` — the per-worker cap on
in-flight turns (S) — has no default anywhere in this deployment: its correct value is an
_output_ of experiment E8, not a guess, so shipping one would silently truncate the E8
ladder it exists to measure. Left unset, the supervisor's own startup check (`readConfig`)
refuses to start rather than falling back to a wrong value.

## What round one does not claim

The systemd `[Service]` hardening directives in `sh-supervisor.service` and
`sh-relay.service` (`ProtectSystem=strict`, `NoNewPrivileges=true`, `SystemCallFilter=`, and
friends) are the VM analogue of a pod's `securityContext` — they narrow the filesystem and
syscall surface available to each process. They are **present, not equivalent**: this round
does **not** claim security-context parity with the Kubernetes deployment, and it does
**not** have any analogue of Kubernetes `NetworkPolicy` egress control. systemd has no
per-unit network-egress primitive comparable to a `NetworkPolicy`, so a VM deployment is
strictly more exposed on that axis until the Z2/Z5 work lands.
