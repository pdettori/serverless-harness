package vmpool

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
)

// jailPool hands out reusable jail ids instead of a fresh chroot per VM.
//
// WHY. #328 decomposed the restore and found the pre-socket window is 93% the JAILER building a
// chroot, not Firecracker, which binds its API socket in 0.37 ms. Reusing a jail directory cuts
// that window from 4685 us to 3228 us -- -31% -- measured on srv-r16b14s16, n=20 per arm, shuffled
// and interleaved, with the previous VMM reaped and the socket deleted before each timed run.
// Since replenishment is restores and the replenishment rate is what bounds throughput, the
// pre-socket window is the live lever.
//
// WHAT THE SAVING ACTUALLY IS, because it constrains the residue policy below. The whole effect is
// the 3.6 MiB `firecracker` the jailer copies in: keep it and reuse is worth -31%, delete it and
// reuse is worth -5%. But the jailer does NOT skip the copy on reuse -- planting tampered content
// there and running again restores the original bytes at the same inode, and a reused jail whose
// old VMM still has it mapped fails with `Text file busy`. So the jailer rewrites those bytes every
// run and what reuse avoids is ALLOCATING the blocks. Two consequences: a tenant's tampering of
// that file cannot survive, and pooling mitigates the copy rather than removing it (only #328's
// option 2, replacing the jailer, would remove it).
//
// REUSE IS KEYED ON --id, so pooling the jail means pooling an id, and VM ids must stay monotonic
// (cgroup.go's naming authority says why: a live VMM holding a jail id is what the collision guard
// refuses on). So this allocates its own namespace, exactly as cgroupPool allocates pool-<n>, and
// the VM keeps its own vm-<n> identity for logs, the sweep and that guard.
//
// A FREE LIST, NOT A SIZED POOL, for the reason cgroupPool gives: nothing here knows the slot
// count, so acquire pops or mints and release pushes back, which makes the high-water mark exactly
// the peak concurrent VM count without anything having to predict it.
type jailPool struct {
	chrootBase string
	execPath   string // FirecrackerBin; its basename is both the jail path segment and the copy
	uid, gid   int

	mu   sync.Mutex
	free []string
	// issued is a NAME ALLOCATOR and never goes backwards, for the reason cgroupPool.issued
	// documents (#319 review): rolling it back on a failed mint is correct single-threaded and
	// hands one name to two live holders concurrently. For a jail that means two VMMs sharing one
	// chroot and one API socket path -- which the collision guard would then refuse for whichever
	// arrived second, i.e. an innocent restore failing because of another's rollback.
	issued   int
	refused  atomic.Int64
	healed   atomic.Int64
	reusedOK atomic.Int64
}

func newJailPool(chrootBase, execPath string, uid, gid int) *jailPool {
	return &jailPool{chrootBase: chrootBase, execPath: execPath, uid: uid, gid: gid}
}

// execName is the one name allowed to survive a tenant, and also the jail path's own segment --
// jailer's convention is <chroot-base>/<exec-file basename>/<id>/root.
func (p *jailPool) execName() string { return filepath.Base(p.execPath) }

// jailRoot resolves a jail id to the directory jailer will chroot into. The single place this
// layout is spelled, so Restore and the pool cannot disagree about which directory is being pooled.
func (p *jailPool) jailRoot(id string) string {
	return filepath.Join(p.chrootBase, p.execName(), id, "root")
}

// jailRemovableNames is the allowlist's complement: everything a jail may legitimately contain
// after a VM has run, all of which is deleted before reuse. Anything NOT here refuses the jail.
//
// Derived from the path constants rather than spelled again, because a jail whose allowlist has
// drifted from what Restore actually writes would refuse every jail -- silently turning the pool
// off -- or, worse, keep something it no longer recognises.
func (p *jailPool) jailRemovableNames() map[string]bool {
	return map[string]bool{
		"dev":                            true, // jailer's four mknod'd nodes; see wipe requirement below
		filepath.Base(apiSockRelPath):    true, // in case a run/ ever stops holding it
		filepath.Dir(apiSockRelPath)[1:]: true, // "run"
		filepath.Base(vsockRelPath):      true,
		"firecracker.pid":                true,
		fileWorkspaceImg:                 true,
		fileVMState:                      true,
		fileMemory:                       true,
		fileKernel:                       true,
		fileRootfs:                       true,
		fileAgent:                        true,
	}
}

// acquire returns a jail id for jailer's --id, reusing an idle one when there is one.
func (p *jailPool) acquire() (string, error) {
	p.mu.Lock()
	if n := len(p.free); n > 0 {
		id := p.free[n-1]
		p.free = p.free[:n-1]
		p.mu.Unlock()
		// VERIFY ON POP, the asymmetry #319's review caught in cgroupPool: release is careful, but
		// an idle entry can change while it sits here -- an operator clearing the chroot base by
		// hand reaches precisely what is idle. Nothing else can hold this name, because it was on
		// the free list, so a dirty one is rebuilt under the SAME name rather than abandoned.
		//
		// A pop-time failure HEALS instead of refusing, unlike release. #319's review made the
		// argument: refusing here is one failed restore per stale entry, and at 64 slots the free
		// list can hold ~100, so the cost would be a burst of failed replenishes. It is also not
		// attributable -- nothing legitimate writes to an idle jail, so this is an operator or a
		// crash, not the previous tenant -- whereas a release-time failure is attributable to the
		// VM that just ran, which is why that one retires the name.
		if err := p.makeReusable(id); err != nil {
			p.healed.Add(1)
			root := p.jailRoot(id)
			log.Printf("vmpool: jail pool: resetting idle jail %s before reuse: %v", root, err)
			if rmErr := os.RemoveAll(root); rmErr != nil {
				// Now it can be neither vouched for nor cleared, so the name goes out of
				// rotation rather than being handed over.
				return "", fmt.Errorf("vmpool: jail pool: reset %s: %w", root, rmErr)
			}
		}
		p.reusedOK.Add(1)
		return id, nil
	}
	seq := p.issued
	p.issued++
	p.mu.Unlock()
	id := pooledJailPrefix + strconv.Itoa(seq)
	// A MINTED name can still have a directory: a restarted worker mints jail-0 again and may find
	// one left by the previous incarnation, holding that incarnation's residue. Applying the same
	// allowlist instead of trusting it also tightens today's behaviour, where Restore tolerates a
	// pre-existing jail with a best-effort remove of six known names and no statement about
	// anything else.
	if err := p.makeReusable(id); err != nil {
		// Same heal-then-proceed as the pop path, and for a stronger reason: this is a restart
		// leftover, so failing here would fail the FIRST restore after every worker restart.
		p.healed.Add(1)
		root := p.jailRoot(id)
		log.Printf("vmpool: jail pool: clearing a leftover jail at the minted name %s: %v", root, err)
		if rmErr := os.RemoveAll(root); rmErr != nil {
			// The name is NOT reclaimed -- see issued.
			return "", fmt.Errorf("vmpool: jail pool: clear %s: %w", root, rmErr)
		}
	}
	return id, nil
}

// release returns a jail for reuse, having first made it safe to reuse.
//
// THE POLICY IS THE ISOLATION ARGUMENT. A pooled jail is a directory the previous VM had write
// access to, so exactly one name may persist -- the exec copy, which is the entire saving -- and it
// persists only if it still passes verifyExec. Everything else is deleted, and anything unexplained
// refuses the jail outright.
//
// Called only after Destroy's cmd.Wait has reaped the VMM, which is not merely tidy: a jail whose
// old VMM still has the exec file mapped fails the next restore with `Text file busy`.
func (p *jailPool) release(id string) {
	if err := p.makeReusable(id); err != nil {
		// Refused, not leaked. cgroupPool must LEAVE a cgroup it cannot vouch for, because
		// something may still be running inside it; a jail can always be removed, so nothing
		// accumulates here and the counter means "a jail was not trusted", not "a directory was
		// abandoned". Removal is what makes the refusal safe rather than merely recorded.
		p.refused.Add(1)
		root := p.jailRoot(id)
		log.Printf("vmpool: jail pool: refusing %s and removing it: %v", root, err)
		if rmErr := os.RemoveAll(root); rmErr != nil {
			log.Printf("vmpool: jail pool: could not remove refused jail %s: %v", root, rmErr)
		}
		// The name is deliberately not returned: an id that has just produced evidence of
		// tampering should stay out of rotation and visible in the logs. A name is an int.
		return
	}
	p.mu.Lock()
	p.free = append(p.free, id)
	p.mu.Unlock()
}

// makeReusable leaves the jail either ABSENT or holding nothing but a verified exec copy. Both are
// reusable states: Restore's prep recreates the directory and its run/ on every restore regardless,
// so an absent jail is simply one that has lost the saving, not one that is broken.
func (p *jailPool) makeReusable(id string) error {
	root := p.jailRoot(id)
	ents, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil // the cleanest state there is
	}
	if err != nil {
		return fmt.Errorf("read jail %s: %w", root, err)
	}
	keep := p.execName()
	removable := p.jailRemovableNames()
	for _, e := range ents {
		name := e.Name()
		if name == keep {
			continue
		}
		if !removable[name] {
			return fmt.Errorf("unexplained entry %q in jail %s", name, root)
		}
		if err := os.RemoveAll(filepath.Join(root, name)); err != nil {
			return fmt.Errorf("strip %q from jail %s: %w", name, root, err)
		}
	}
	return p.verifyExec(root)
}

// verifyExec decides whether the one persisted file may be trusted.
//
// It is an EXECUTABLE the next tenant's jailer opens for writing AS ROOT, before it drops to
// --uid/--gid, so this is the only place in #328 where a performance change touches isolation. Two
// attacks, both tested on the rig rather than reasoned about:
//
//   - Symlink, which would make the jailer's own write an arbitrary-file-overwrite primitive. NOT
//     exploitable: the jailer opens that path O_NOFOLLOW and exits with ELOOP, verified against a
//     byte-for-byte intact canary. S_ISREG below is defence in depth behind that -- and it also
//     rejects a FIFO, whose write would block the jailer forever.
//   - Hardlink, which O_NOFOLLOW does NOT stop. The jail holds our own prep's hardlinks to the
//     GOLDEN SNAPSHOT, so a compromised VMM could link the exec path onto memfile and have the next
//     jailer run write 3.6 MiB of Firecracker into the snapshot every VM on the host restores from.
//     st_nlink == 1 is what catches that, and it is why this check is not optional.
//
// Contents are deliberately NOT hashed. The jailer overwrites them unconditionally, so content
// cannot survive a restore, and hashing 3.6 MiB per release would cost more than the 1.46 ms the
// whole change saves. What has to be guaranteed is the inode's identity, not its bytes.
//
// The source is stat'ed per call rather than cached at construction: a binary replaced under a
// running worker then invalidates the pooled jails it should invalidate, instead of a cached size
// disagreeing with every future mint and refusing the pool into uselessness.
func (p *jailPool) verifyExec(root string) error {
	path := filepath.Join(root, p.execName())
	fi, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil // no copy to vouch for; the jail is still reusable, just without the saving
	}
	if err != nil {
		return fmt.Errorf("lstat %s: %w", path, err)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file (mode %s)", path, fi.Mode())
	}
	src, err := os.Stat(p.execPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", p.execPath, err)
	}
	if fi.Size() != src.Size() {
		return fmt.Errorf("%s is %d bytes, want %d", path, fi.Size(), src.Size())
	}
	nlink, uid, ok := jailExecIdentity(fi)
	if !ok {
		return fmt.Errorf("cannot read the link count of %s on this platform", path)
	}
	if nlink != 1 {
		return fmt.Errorf("%s has %d links; it is hardlinked to something else", path, nlink)
	}
	if uid != p.uid {
		return fmt.Errorf("%s is owned by uid %d, want %d", path, uid, p.uid)
	}
	return nil
}

func (p *jailPool) idle() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.free)
}

// mintedCount reports how many NAMES have been allocated, which after a failed mint exceeds the
// number of jails that exist. Deliberate: see issued.
func (p *jailPool) mintedCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.issued
}

func (p *jailPool) refusals() int64 { return p.refused.Load() }

// heals counts jails cleared on the way OUT because they could not be vouched for -- an operator
// clearing the chroot base, or a restart leftover. Distinct from refusals, which are attributable
// to the tenant that just ran, because the two want different responses from whoever reads them.
func (p *jailPool) heals() int64 { return p.healed.Load() }

// reuses counts jails handed back out of the free list, which is what the -31% is earned on. A
// reuse rate far below one per restore means the pool is refusing or dropping more than it keeps.
func (p *jailPool) reuses() int64 { return p.reusedOK.Load() }
