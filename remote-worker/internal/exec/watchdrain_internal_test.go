package exec

// Internal (package exec, not exec_test) so watchDrain can be driven directly.
// The end-to-end behaviour lives in TestSlowDrainKeepsTrailingOutput and
// TestRunReturnsWhenPipeHolderEscapesGroup; both need a real child holding a real
// pipe, which makes them seconds long and, for the escaped-holder case, dependent
// on what the platform provides. These cover the decision logic at millisecond
// timings instead — above all the ceiling, which an end-to-end test would have to
// wait 30 real seconds to reach.

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The grace and ceiling watchDrain is given here bear no relation to drainGrace
// and drainCeiling; they are arguments precisely so these tests need not wait
// seconds. The ratio between them is what matters, and it matches production's.
const (
	testGrace   = 50 * time.Millisecond
	testCeiling = 500 * time.Millisecond
)

// spyCloser records that it was closed. Close is safe to call twice, since
// watchDrain closes every closer it was given and a test may also be inspecting.
type spyCloser struct {
	mu     sync.Mutex
	closed bool
}

func (c *spyCloser) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

func (c *spyCloser) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// waitClosed polls until c is closed or the deadline passes.
func waitClosed(c *spyCloser, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if c.isClosed() {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return false
}

// The wedged case: runCtx has ended and no read has returned bytes since. Only a
// force-close can unblock a pump parked in Read on a pipe nothing will ever write
// to again.
func TestWatchDrainClosesWhenPumpsGoQuiet(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var reads atomic.Uint64
	out, errp := &spyCloser{}, &spyCloser{}
	done := make(chan struct{})
	defer close(done)

	go watchDrain(ctx, done, &reads, testGrace, testCeiling, out, errp)
	cancel()

	if !waitClosed(out, 2*time.Second) {
		t.Error("stdout pipe was never force-closed: a wedged pump would block Run forever")
	}
	if !errp.isClosed() {
		t.Error("stderr pipe was not closed: both pumps must be released, not just one")
	}
}

// The slow case, which a wall-clock grace could not distinguish from the wedged
// one (#173 item 6). Reads keep arriving four times per grace period, so the
// watchdog must keep waiting — force-closing here discards output the command
// legitimately produced. The ceiling is pushed out of the way so this test is
// about the reset and nothing else.
func TestWatchDrainHoldsOffWhileReadsProgress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var reads atomic.Uint64
	pipe := &spyCloser{}
	done := make(chan struct{})
	defer close(done)

	ticker := time.NewTicker(testGrace / 4)
	defer ticker.Stop()
	stopTicks := make(chan struct{})
	defer close(stopTicks)
	go func() {
		for {
			select {
			case <-ticker.C:
				reads.Add(1)
			case <-stopTicks:
				return
			}
		}
	}()

	go watchDrain(ctx, done, &reads, testGrace, time.Hour, pipe)
	cancel()

	// Six grace periods of steady progress. A wall-clock grace closes after one.
	time.Sleep(6 * testGrace)
	if pipe.isClosed() {
		t.Error("the pipe was force-closed while reads were still arriving: trailing output is lost")
	}
}

// ...but the hold-off is not unconditional. A holder trickling forever would
// otherwise pin a pool slot and its buffer indefinitely — a slower version of the
// wedge the watchdog exists to prevent — so progress buys time only up to the
// ceiling.
func TestWatchDrainClosesAtCeilingDespiteProgress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var reads atomic.Uint64
	pipe := &spyCloser{}
	done := make(chan struct{})
	defer close(done)

	ticker := time.NewTicker(testGrace / 4)
	defer ticker.Stop()
	stopTicks := make(chan struct{})
	defer close(stopTicks)
	go func() {
		for {
			select {
			case <-ticker.C:
				reads.Add(1)
			case <-stopTicks:
				return
			}
		}
	}()

	start := time.Now()
	go watchDrain(ctx, done, &reads, testGrace, testCeiling, pipe)
	cancel()

	if !waitClosed(pipe, 5*time.Second) {
		t.Fatal("the pipe was never force-closed despite unbroken progress: the activity reset has no ceiling")
	}
	// Timers never fire early, so this lower bound cannot flake — and without it
	// the test would also pass against a watchdog that ignored progress entirely.
	if elapsed := time.Since(start); elapsed < testCeiling {
		t.Errorf("closed after %v, before the %v ceiling: progress did not defer the close at all", elapsed, testCeiling)
	}
}

// The common case by far: the exec finished on its own. The watchdog must return
// without touching the pipes, or it would close readers Wait is entitled to close
// itself.
func TestWatchDrainLeavesPipesAloneWhenExecFinishes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var reads atomic.Uint64
	pipe := &spyCloser{}
	done := make(chan struct{})

	returned := make(chan struct{})
	go func() {
		defer close(returned)
		watchDrain(ctx, done, &reads, testGrace, testCeiling, pipe)
	}()

	close(done) // Run reached a return path
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("watchDrain did not return when the exec finished: its goroutine leaks for every exec")
	}
	// Well past both grace and ceiling: nothing may arrive late.
	time.Sleep(2 * testCeiling)
	if pipe.isClosed() {
		t.Error("a healthy exec's pipe was force-closed")
	}
}

// A quiet drain must not be force-closed BEFORE runCtx ends, however long it
// takes: a command inside its timeout that simply produces nothing yet is not a
// candidate for teardown.
func TestWatchDrainWaitsForRunCtxBeforeAnyClose(t *testing.T) {
	var reads atomic.Uint64
	pipe := &spyCloser{}
	done := make(chan struct{})
	defer close(done)

	go watchDrain(context.Background(), done, &reads, testGrace, testCeiling, pipe)

	time.Sleep(3 * testCeiling)
	if pipe.isClosed() {
		t.Error("the pipe was force-closed while the run context was still live")
	}
}
