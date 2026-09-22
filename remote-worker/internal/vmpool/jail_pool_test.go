package vmpool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A jail pool over a temp chroot base, with a fake "firecracker" binary of a known size standing
// in for the 3.6 MiB the jailer copies.
func testJailPool(t *testing.T) (*jailPool, string) {
	t.Helper()
	base := t.TempDir()
	bin := filepath.Join(base, "bin", "firecracker")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("ELF-ish payload"), 0o755); err != nil {
		t.Fatal(err)
	}
	return newJailPool(filepath.Join(base, "jail"), bin, os.Getuid(), os.Getgid()), bin
}

// Populates a jail the way one looks after a VM has run: the jailer's exec copy and device nodes
// (plain files here -- mknod needs CAP_MKNOD), Firecracker's sockets and pid file, and the six
// hardlinks Restore's own prep puts in.
func populateJail(t *testing.T, p *jailPool, id string, src string) string {
	t.Helper()
	root := p.jailRoot(id)
	for _, d := range []string{"dev/net", "run"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	payload, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "firecracker"), payload, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{
		"dev/kvm", "dev/urandom", "dev/userfaultfd", "dev/net/tun",
		"firecracker.pid", "vsock.sock", "run/firecracker.socket", "workspace.img",
		fileVMState, fileMemory, fileKernel, fileRootfs, fileAgent,
	} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestJailPoolReusesAnIdAndMintsDistinctOnesOtherwise(t *testing.T) {
	p, bin := testJailPool(t)
	first, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("two concurrent acquires got the same jail id %q", first)
	}
	populateJail(t, p, first, bin)
	p.release(first)
	if got := p.idle(); got != 1 {
		t.Fatalf("idle() = %d after one release, want 1 (refused=%d)", got, p.refusals())
	}
	again, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	if again != first {
		t.Fatalf("acquire after release got %q, want the pooled %q", again, first)
	}
}

// The residue policy, which is the whole isolation argument: exactly one name may survive a
// tenant. Everything else -- including the workspace image, whose hardlink would otherwise pin the
// previous run's inode past detachWorkspace's RemoveAll -- must be gone before the jail is
// reusable.
func TestJailPoolStripsEveryPerVMPathButTheExecFile(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := populateJail(t, p, id, bin)
	p.release(id)

	if p.refusals() != 0 {
		t.Fatalf("a normal jail was refused: %d", p.refusals())
	}
	left, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("the jail must survive release, it is the thing being pooled: %v", err)
	}
	var names []string
	for _, e := range left {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != "firecracker" {
		t.Fatalf("release left %v; only the exec copy may persist", names)
	}
}

// THE load-bearing check. The jail contains our own hardlinks to the GOLDEN SNAPSHOT, and the
// jailer opens the exec path for writing as root before it drops privileges. A compromised VMM
// that relinked that path onto memfile would have the next restore write 3.6 MiB of the
// Firecracker binary into the snapshot every VM on the host restores from. O_NOFOLLOW does not
// help here -- a hardlink is not a symlink -- so st_nlink == 1 is what has to catch it.
func TestJailPoolRefusesAnExecFileHardlinkedToSomethingElse(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := populateJail(t, p, id, bin)
	exec := filepath.Join(root, "firecracker")
	if err := os.Remove(exec); err != nil {
		t.Fatal(err)
	}
	// The relink target is the golden memfile's stand-in, at the size that would otherwise pass.
	golden := filepath.Join(t.TempDir(), "memfile")
	payload, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(golden, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(golden, exec); err != nil {
		t.Skipf("hardlink unsupported here: %v", err)
	}

	p.release(id)
	if p.refusals() != 1 {
		t.Fatalf("a hardlinked exec file must be refused, refusals=%d", p.refusals())
	}
	if p.idle() != 0 {
		t.Fatal("a refused jail must not reach the free list")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("a refused jail must be removed, stat gave %v", err)
	}
	// Removing the jail must not touch the relink target -- that is the snapshot.
	if _, err := os.Stat(golden); err != nil {
		t.Fatalf("refusing the jail destroyed the relink target: %v", err)
	}
}

func TestJailPoolRefusesASymlinkedExecFile(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := populateJail(t, p, id, bin)
	exec := filepath.Join(root, "firecracker")
	if err := os.Remove(exec); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bin, exec); err != nil {
		t.Fatal(err)
	}
	p.release(id)
	if p.refusals() != 1 {
		t.Fatalf("a symlinked exec file must be refused, refusals=%d", p.refusals())
	}
}

func TestJailPoolRefusesAnExecFileOfTheWrongSize(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := populateJail(t, p, id, bin)
	if err := os.WriteFile(filepath.Join(root, "firecracker"), []byte("short"), 0o755); err != nil {
		t.Fatal(err)
	}
	p.release(id)
	if p.refusals() != 1 {
		t.Fatalf("an exec file of the wrong size must be refused, refusals=%d", p.refusals())
	}
}

// Fails closed on anything the allowlist does not name, rather than deleting it silently: an
// unexplained file in a jail is evidence that something wrote there, and the counter is what makes
// it visible.
func TestJailPoolRefusesAJailWithAnUnexplainedEntry(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	root := populateJail(t, p, id, bin)
	if err := os.WriteFile(filepath.Join(root, "planted.so"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	p.release(id)
	if p.refusals() != 1 {
		t.Fatalf("an unexplained entry must refuse the jail, refusals=%d", p.refusals())
	}
	if p.idle() != 0 {
		t.Fatal("a refused jail must not reach the free list")
	}
}

// An absent jail is the cleanest state there is, so it is reusable rather than refused -- Restore's
// prep recreates the directory on every restore regardless. Reachable whenever an operator clears
// the chroot base by hand.
func TestJailPoolTreatsAnAbsentJailAsReusable(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	populateJail(t, p, id, bin)
	if err := os.RemoveAll(p.jailRoot(id)); err != nil {
		t.Fatal(err)
	}
	p.release(id)
	if p.refusals() != 0 {
		t.Fatalf("an absent jail is clean, not a refusal: refusals=%d", p.refusals())
	}
	if p.idle() != 1 {
		t.Fatalf("an absent jail must be reusable, idle=%d", p.idle())
	}
}

// A dirty jail popped off the free list is rebuilt under the SAME name rather than handed over:
// nothing else can hold it, because it was idle. Mirrors cgroupPool's verify-on-pop, which #319's
// review added for exactly this asymmetry.
func TestJailPoolResetsADirtyJailOnPop(t *testing.T) {
	p, bin := testJailPool(t)
	id, _, err := p.acquire()
	if err != nil {
		t.Fatal(err)
	}
	populateJail(t, p, id, bin)
	p.release(id)
	// Something appears in the idle jail after it was checked.
	if err := os.WriteFile(filepath.Join(p.jailRoot(id), "appeared-while-idle"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, _, err := p.acquire()
	if err != nil {
		t.Fatalf("acquire on a dirty idle jail: %v", err)
	}
	if got != id {
		t.Fatalf("acquire returned %q, want the same name %q rebuilt", got, id)
	}
	if _, err := os.Stat(filepath.Join(p.jailRoot(id), "appeared-while-idle")); !os.IsNotExist(err) {
		t.Fatalf("acquire handed out a jail still holding foreign content: %v", err)
	}
	// Counted as a heal, NOT a refusal: nothing legitimate writes to an idle jail, so this is an
	// operator or a crash rather than the previous tenant, and the two want different responses
	// from whoever reads the counters.
	if p.heals() != 1 || p.refusals() != 0 {
		t.Fatalf("heals=%d refusals=%d; a dirty IDLE jail is a heal, not a refusal", p.heals(), p.refusals())
	}
}

// #319's review, transplanted: a name must never be reclaimed after a failed mint. MkdirAll
// returns nil on an existing directory, so a rolled-back counter can hand one live jail to two
// VMs -- and for a jail that means two VMMs sharing one chroot and one API socket path, which the
// collision guard would then refuse for the innocent one.
func TestJailPoolNeverReclaimsANameAfterAFailedMint(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores the directory permissions this stages the failure with")
	}
	p, _ := testJailPool(t)
	// Make jail-0's reset fail: a non-empty directory inside a parent that cannot be written.
	root := p.jailRoot(pooledJailPrefix + "0")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "stuck"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o700) })

	if _, _, err := p.acquire(); err == nil {
		t.Fatal("acquire must fail when it cannot make the jail reusable")
	}
	next, _, err := p.acquire()
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if strings.HasSuffix(next, "-0") {
		t.Fatalf("acquire reclaimed the failed name %q", next)
	}
	if p.mintedCount() < 2 {
		t.Fatalf("mintedCount = %d; a failed mint still consumes its name", p.mintedCount())
	}
}

// THE REGRESSION THIS FILE EXISTS FOR, and the one the unit tests could not see before the seam
// was extracted. jailer's --id is the ONLY thing that determines the chroot path, so it must carry
// the POOLED jail id, not the VM id. Shipping `--id req.ID` alongside a pooled jailRoot produced a
// silent, expensive failure on the rig: the jailer built a complete working jail at vm-1 -- dev
// nodes, API socket, pid file, exec copy, all present -- while waitForUnixSocket watched jail-0,
// and the restore died 5 s later as "API socket never appeared", which points at Firecracker
// rather than at the id.
func TestJailerArgsCarryThePooledJailIdNotTheVMId(t *testing.T) {
	opts := FirecrackerOptions{
		FirecrackerBin: "/usr/local/bin/firecracker",
		JailerBin:      "/usr/local/bin/jailer",
		ChrootBase:     "/srv/jail",
		UID:            0, GID: 0,
	}
	args := firecrackerJailerArgs("jail-7", opts, "microvm.slice/microvm-vms.slice/pool-3")

	var id string
	for i, a := range args {
		if a == "--id" && i+1 < len(args) {
			id = args[i+1]
		}
		if a == "--" {
			break // everything after is Firecracker's own argv
		}
	}
	if id != "jail-7" {
		t.Fatalf("--id = %q, want the pooled jail id \"jail-7\"; args: %v", id, args)
	}

	// And the directory the launcher prepares must be the one that id names, by the SAME
	// derivation the pool uses -- that shared derivation is what stops the two drifting again.
	p := newJailPool(opts.ChrootBase, opts.FirecrackerBin, opts.UID, opts.GID)
	want := firecrackerJailRoot(opts.ChrootBase, opts.FirecrackerBin, id)
	if got := p.jailRoot(id); got != want {
		t.Fatalf("pool jailRoot=%q but launcher derives %q for the same id", got, want)
	}
	if want != "/srv/jail/firecracker/jail-7/root" {
		t.Fatalf("jail layout changed: %q; jailer's convention is <chroot-base>/<exec basename>/<id>/root", want)
	}
}
