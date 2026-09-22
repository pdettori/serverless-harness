package vmpool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeCgFile adds one control file to a fake cgroup directory.
func writeCgFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// #258. rmdir removes the DIRECTORY but does not free the cgroup: the memory controller keeps it
// alive while any page is charged to it, so the kernel parks it as a "dying" cgroup. Measured on
// srv-r16b14s16: 12,454 dying descendants under the VM slice with ZERO live children, and cgroup
// operation cost grows with that population -- the host measured ~24% slower at c=64 than it had
// two hours earlier, with a clean directory count both times.
//
// Asking the kernel to reclaim the cgroup's charges before removing the directory lets it free
// the structure instead. OPT-IN, because the sign of the effect is genuinely unknown: a large
// share of those charges will be page cache for the 704 MiB snapshot memory file that every
// restore reads and that we WANT cached, and v2 does not migrate charges on death -- so this may
// trade a dying-cgroup count for restore-path page-cache misses. It ships dark until measured.
func TestReclaimBeforeRmdirIsOptInAndOffByDefault(t *testing.T) {
	slice := fakeSlice(t, map[string][]string{"vm-1": {}})
	dir := filepath.Join(slice, "vm-1")
	writeCgFile(t, dir, "memory.current", "104857600\n")
	writeCgFile(t, dir, "memory.reclaim", "")

	// The DEFAULT is off, asserted through the parsing rather than through the package var:
	// reading the var would fail whenever the suite runs with the flag set, which is exactly how
	// the flag gets exercised on the rig.
	if reclaimEnabledFrom("") {
		t.Fatal("reclaim must default to OFF -- the sign of the effect is unmeasured")
	}
	if !reclaimEnabledFrom("1") {
		t.Fatal("SH_CGROUP_RECLAIM_ON_DESTROY=1 must enable it, or the A/B cannot be run")
	}
	for _, off := range []string{"", "0", "true", "yes", "2"} {
		if reclaimEnabledFrom(off) {
			t.Errorf("%q must not enable reclaim: exactly \"1\", so a typo fails closed", off)
		}
	}
	if err := removeCgroupDir(dir); err != nil {
		t.Fatalf("removeCgroupDir: %v", err)
	}
	// Non-vacuousness for the "off" case is the absence of a write, which a removed directory
	// cannot show -- so check the helper directly instead.
	slice2 := fakeSlice(t, map[string][]string{"vm-2": {}})
	dir2 := filepath.Join(slice2, "vm-2")
	writeCgFile(t, dir2, "memory.current", "104857600\n")
	writeCgFile(t, dir2, "memory.reclaim", "")
	reclaimCgroupCharges(dir2, false)
	if b, _ := os.ReadFile(filepath.Join(dir2, "memory.reclaim")); len(b) != 0 {
		t.Fatalf("memory.reclaim was written with the gate off: %q", b)
	}
}

// With the gate on it asks for exactly memory.current. Not a huge sentinel value: writing more
// than is present makes the kernel return EAGAIN even though it reclaimed everything it could,
// which would make every removal look like a failure.
func TestReclaimAsksForExactlyMemoryCurrent(t *testing.T) {
	slice := fakeSlice(t, map[string][]string{"vm-3": {}})
	dir := filepath.Join(slice, "vm-3")
	writeCgFile(t, dir, "memory.current", "104857600\n")
	writeCgFile(t, dir, "memory.reclaim", "")

	reclaimCgroupCharges(dir, true)

	b, err := os.ReadFile(filepath.Join(dir, "memory.reclaim"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(b)); got != "104857600" {
		t.Fatalf("memory.reclaim = %q, want the value read from memory.current", got)
	}
}

// Best effort, always. A cgroup with nothing charged, an older kernel with no memory.reclaim, and
// an unreadable memory.current must all leave removal working -- reclaiming is an optimisation,
// and failing a Destroy over it would trade a 195 ms phase for a counted destroyFailed.
func TestReclaimIsBestEffortAndNeverBlocksRemoval(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, dir string)
	}{
		{"nothing charged", func(t *testing.T, dir string) {
			writeCgFile(t, dir, "memory.current", "0\n")
			writeCgFile(t, dir, "memory.reclaim", "")
		}},
		{"no memory.reclaim (older kernel)", func(t *testing.T, dir string) {
			writeCgFile(t, dir, "memory.current", "104857600\n")
		}},
		{"no memory.current", func(t *testing.T, dir string) {
			writeCgFile(t, dir, "memory.reclaim", "")
		}},
		{"garbage in memory.current", func(t *testing.T, dir string) {
			writeCgFile(t, dir, "memory.current", "not-a-number\n")
			writeCgFile(t, dir, "memory.reclaim", "")
		}},
		{"neither file", func(t *testing.T, dir string) {}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			slice := fakeSlice(t, map[string][]string{"vm-x": {}})
			dir := filepath.Join(slice, "vm-x")
			tc.setup(t, dir)
			reclaimCgroupCharges(dir, true) // must not panic
			if err := removeCgroupDir(dir); err != nil {
				t.Fatalf("removeCgroupDir after reclaim: %v", err)
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("dir survived removal (err=%v)", err)
			}
		})
	}
}

// Nothing charged must not write at all: a zero-byte reclaim request is a syscall for no reason,
// on a path that runs once per Exec.
func TestReclaimSkipsWhenNothingIsCharged(t *testing.T) {
	slice := fakeSlice(t, map[string][]string{"vm-4": {}})
	dir := filepath.Join(slice, "vm-4")
	writeCgFile(t, dir, "memory.current", "0\n")
	writeCgFile(t, dir, "memory.reclaim", "")

	reclaimCgroupCharges(dir, true)

	if b, _ := os.ReadFile(filepath.Join(dir, "memory.reclaim")); len(b) != 0 {
		t.Fatalf("wrote %q for a cgroup with nothing charged", b)
	}
}
