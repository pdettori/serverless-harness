//go:build !unix

package exec

import (
	"fmt"
	osexec "os/exec"
	"runtime"
)

// The non-unix half: a refusal, deliberately not a second implementation.
//
// Process-group isolation is not a nicety here — it is what makes abort and
// timeout actually stop a command's grandchildren, and the runner has no
// correct behaviour without it. So rather than build a version that runs
// commands it cannot reliably kill, this platform refuses at the top of Run,
// naming the reason. That is the whole point of the constraint (#173 item 8):
// before it, a Windows build failed with "unknown field Setpgid" and
// "undefined: syscall.Kill" — two errors about a struct literal that never
// mention the platform.

// platformSupported refuses before any child is spawned.
func platformSupported() error {
	return fmt.Errorf("remote-worker is unix-only: %s has no equivalent of the "+
		"process-group isolation (Setpgid/Kill) that abort and timeout depend on", runtime.GOOS)
}

// isolateProcessGroup is unreachable — Run returns on platformSupported first.
// It exists so runner.go needs no build tags of its own.
func isolateProcessGroup(*osexec.Cmd) {}

// killProcessGroup is likewise unreachable, and says so rather than reporting a
// success it did not achieve.
func killProcessGroup(int) error {
	return platformSupported()
}
