//go:build unix

package vmpool

import (
	"os"
	"syscall"
)

// jailExecIdentity reports the link count and owning uid of an already-lstat'ed file.
//
// Split by platform because syscall.Stat_t does not exist on windows, and st_nlink is uint16 on
// darwin against uint64 on linux. A platform that cannot answer returns ok=false, which
// jailPool treats as a refusal rather than a pass: "cannot tell" is not "clean".
func jailExecIdentity(fi os.FileInfo) (nlink uint64, uid int, ok bool) {
	st, isStat := fi.Sys().(*syscall.Stat_t)
	if !isStat {
		return 0, 0, false
	}
	return uint64(st.Nlink), int(st.Uid), true
}
