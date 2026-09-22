//go:build !unix

package vmpool

import "os"

// jailExecIdentity cannot answer off unix, so the pool refuses every jail rather than reusing one
// it could not check. Firecracker and its jailer are Linux-only regardless; this exists so the
// package still builds, not so the pool works here.
func jailExecIdentity(os.FileInfo) (nlink uint64, uid int, ok bool) { return 0, 0, false }
