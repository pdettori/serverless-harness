//go:build unix

package vmpool

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// A jail pool under a SHORT /tmp base: sun_path caps at 104 bytes on darwin, and the jail layout
// adds <exec>/<id>/root/run/firecracker.socket on top of it. Same reason sockBase exists.
func testOccupiedJailPool(t *testing.T) (*jailPool, string) {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "jailocc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	bin := filepath.Join(base, "fc")
	if err := os.WriteFile(bin, []byte("ELF-ish payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	return newJailPool(filepath.Join(base, "j"), bin, os.Getuid(), os.Getgid()), bin
}

// Puts a real listener at the jail's API socket path, i.e. a VMM that survived Destroy's kill and
// Wait by escaping the process group.
func occupyPooledJail(t *testing.T, p *jailPool, id string) string {
	t.Helper()
	root := p.jailRoot(id)
	if err := os.MkdirAll(filepath.Join(root, filepath.Dir(apiSockRelPath)), 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(root, apiSockRelPath)
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen on %s: %v", sock, err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return root
}

// THE destructive case, reached from the pool's side rather than Restore's. makeReusable deletes
// run/ -- which holds the API socket -- so without the occupancy guard a jail still held by a live
// VMM would lose its socket while its process kept running. That is exactly the collision Restore's
// own guard documents as "silently destructive in both directions".
//
// Leaked rather than refused: the directory is LEFT ALONE precisely because something is using it,
// which is the one case this pool abandons a directory, and the same posture cgroupPool takes on a
// non-empty cgroup.procs.
func TestJailPoolLeavesAnOccupiedJailAloneOnRelease(t *testing.T) {
	p, _ := testOccupiedJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := occupyPooledJail(t, p, id)
	sock := filepath.Join(root, apiSockRelPath)

	p.release(id)

	if p.leaks() != 1 {
		t.Fatalf("leaks=%d; a jail a live VMM still holds must be counted as leaked", p.leaks())
	}
	if p.refusals() != 0 {
		t.Fatalf("refusals=%d; an occupied jail is a leak, not a refusal (it must not be removed)", p.refusals())
	}
	if p.idle() != 0 {
		t.Fatal("an occupied jail must not reach the free list")
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("release destroyed a live VMM's API socket: %v", err)
	}
}

// The same guard on the mint path, which is where a restarted worker meets an orphan: it mints
// jail-0 again and must not strip a jail whose VMM outlived the previous incarnation.
func TestJailPoolRefusesToMintOverAnOccupiedJail(t *testing.T) {
	p, _ := testOccupiedJailPool(t)
	root := occupyPooledJail(t, p, pooledJailPrefix+"0")
	sock := filepath.Join(root, apiSockRelPath)

	if _, _, err := p.acquire(); err == nil {
		t.Fatal("acquire must refuse a minted name a live VMM still holds")
	}
	if p.leaks() != 1 {
		t.Fatalf("leaks=%d, want 1", p.leaks())
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("acquire destroyed a live VMM's API socket: %v", err)
	}
	// The failed name is not reclaimed, so the next acquire moves on rather than colliding again.
	next, _, err := p.acquire()
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if next == pooledJailPrefix+"0" {
		t.Fatalf("acquire reclaimed the occupied name %q", next)
	}
}

// A socket FILE with nothing behind it is NOT occupancy -- a crashed VMM leaves one behind, and
// treating it as occupied would refuse every jail after an unclean exit. Same distinction
// fcJailOccupied is built on, asserted here because the pool now depends on it too.
func TestJailPoolTreatsADeadSocketFileAsFree(t *testing.T) {
	p, bin := testOccupiedJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := p.jailRoot(id)
	if err := os.MkdirAll(filepath.Join(root, filepath.Dir(apiSockRelPath)), 0o700); err != nil {
		t.Fatal(err)
	}
	// A plain file where the socket was, which is what is left once the listener is gone.
	if err := os.WriteFile(filepath.Join(root, apiSockRelPath), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "fc"), payload, 0o755); err != nil {
		t.Fatal(err)
	}
	p.release(id)
	if p.leaks() != 0 || p.refusals() != 0 {
		t.Fatalf("leaks=%d refusals=%d; a dead socket file is not occupancy", p.leaks(), p.refusals())
	}
	if p.idle() != 1 {
		t.Fatalf("idle=%d; the jail must be reusable", p.idle())
	}
}
