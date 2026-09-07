//go:build unix

package exec

import (
	osexec "os/exec"
	"syscall"
)

// The unix half of the runner's process-group handling. It is isolated here for
// one reason only: syscall.SysProcAttr's fields are per-platform, so referencing
// Setpgid from runner.go made every non-unix build fail inside that file with
// "unknown field Setpgid" — an error about a struct literal, describing nothing
// about the real cause (#173 item 8). The worker ships as a Linux container, so
// the !unix side is a refusal, not a second implementation.

// platformSupported reports whether this build can isolate a child in its own
// process group. Nil here; see runner_other.go for why the check exists at all.
func platformSupported() error { return nil }

// isolateProcessGroup puts the child in a new process group so killProcessGroup
// can take out the whole pipeline. CommandContext's default signals only the
// direct bash, but real commands have grandchildren
// (`cd 'x' && rg --files … | head -n 200`) that would otherwise survive an abort
// or a timeout.
func isolateProcessGroup(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup SIGKILLs the group led by pid — the negative pid is what makes
// it the group rather than the one process.
func killProcessGroup(pid int) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
