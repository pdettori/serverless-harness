package exec_test

import (
	osexec "os/exec"
	"runtime"
	"testing"
)

// The worker is a Linux container, so no non-unix implementation is needed — but
// the syscall.Setpgid/Kill calls in runner.go must be behind a build constraint
// all the same, or a non-unix build fails deep inside the file with "unknown
// field Setpgid" and "undefined: syscall.Kill" (#173 item 8). Two opaque errors
// about a struct field say nothing about the actual cause, which is that the
// platform is unsupported.
//
// This cross-compiles the module rather than asserting on the constraint's text:
// the property worth pinning is that a non-unix build SUCCEEDS and reports the
// unsupported platform at run time, from the one place that says so in words.
// A comment claiming the tag is present cannot go stale in a way this misses.
func TestModuleCrossCompilesForNonUnix(t *testing.T) {
	goBin, err := osexec.LookPath("go")
	if err != nil {
		t.Skip("no go toolchain in PATH: cannot cross-compile")
	}
	cmd := osexec.Command(goBin, "build", "-o", t.TempDir(), "./...")
	cmd.Dir = "../.." // the remote-worker module root
	cmd.Env = append(cmd.Environ(), "GOOS=windows", "GOARCH=amd64")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("GOOS=windows build failed (%v); the unix-only syscalls are not behind a build constraint:\n%s", err, out)
	}
	if runtime.GOOS == "windows" {
		t.Fatal("this test cross-compiles FOR windows; running it ON windows proves nothing")
	}
}
