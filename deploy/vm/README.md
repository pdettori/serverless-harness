# Single-VM deployment (P6 process-manager runtime)

Round one's target for the VM process-manager runtime (spec §4.3, §4.4, step 4): a single
Linux VM running the supervisor and relay under systemd, with Redis and the sandbox
containers as podman containers alongside them. `setup-vm.sh` is the sibling of
`deploy/knative/setup-kind.sh` and `deploy/knative/setup-ocp.sh`.

## Prerequisites

- A Linux VM with systemd and [podman](https://podman.io/) installed
- Node.js 22+ on the VM (the supervisor and relay run directly via `node --import tsx`, not
  containerized)
- A user able to install systemd units under `/etc/systemd/system` (typically via `sudo`)

## Bring it up

```bash
cd /opt/serverless-harness   # this checkout, on the VM
./deploy/vm/setup-vm.sh
```

That one command:

1. Writes `/etc/serverless-harness/supervisor.env` from `env/supervisor.env.example` — only
   the first time; an operator-edited env file is never clobbered on a re-run.
2. Installs `systemd/sh-supervisor.service` and `systemd/sh-relay.service` into
   `/etc/systemd/system` and reloads the daemon.
3. Starts a Redis container and `SH_SANDBOX_COUNT` (default 2) sandbox containers via podman.
4. Enables and starts the relay and supervisor units.

Before starting the supervisor, edit `/etc/serverless-harness/supervisor.env` and set
`SH_TURNS_PER_WORKER` — it ships empty on purpose (see below) — then
`systemctl restart sh-supervisor.service`.

## Where the env file lives

`/etc/serverless-harness/supervisor.env` (mode 0640, owned by the `harness` user/group),
installed once from `deploy/vm/env/supervisor.env.example`. `SH_TURNS_PER_WORKER` — the
per-worker cap on in-flight turns (S) — has no default anywhere in this deployment: its
correct value is an _output_ of experiment E8, not a guess, so shipping one would silently
truncate the E8 ladder it exists to measure. The unit's `EnvironmentFile=` directive fails
the service to start rather than falling back to a wrong value if it's left unset when the
supervisor reads it.

## What round one does not claim

The systemd `[Service]` hardening directives in `sh-supervisor.service` and
`sh-relay.service` (`ProtectSystem=strict`, `NoNewPrivileges=true`, `SystemCallFilter=`, and
friends) are the VM analogue of a pod's `securityContext` — they narrow the filesystem and
syscall surface available to each process. They are **present, not equivalent**: this round
does **not** claim security-context parity with the Kubernetes deployment, and it does
**not** have any analogue of Kubernetes `NetworkPolicy` egress control. systemd has no
per-unit network-egress primitive comparable to a `NetworkPolicy`, so a VM deployment is
strictly more exposed on that axis until the Z2/Z5 work lands.
