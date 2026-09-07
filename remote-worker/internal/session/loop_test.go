package session_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/kagenti/serverless-harness/gen/go/sandbox/v1"
	wexec "github.com/kagenti/serverless-harness/remote-worker/internal/exec"
	"github.com/kagenti/serverless-harness/remote-worker/internal/session"
)

// fakeStream is a Stream whose Recv is scripted and whose Sends are recorded.
type fakeStream struct {
	in  chan *pb.ServerFrame
	mu  sync.Mutex
	out []*pb.WorkerFrame
	// closed once Recv should report the stream is gone.
	done chan struct{}
	// closeOnce makes close() idempotent. serve's cleanup always closes the
	// stream, so a test that also closes it mid-run (to observe a reconnect, or
	// Serve's return value) must not panic on the second close.
	closeOnce sync.Once
	// failAfter, when > 0, makes Send fail once sendCalls exceeds it.
	failAfter int
	sendCalls int
}

func newFakeStream() *fakeStream {
	return &fakeStream{in: make(chan *pb.ServerFrame, 16), done: make(chan struct{})}
}

func (f *fakeStream) Send(fr *pb.WorkerFrame) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sendCalls++
	if f.failAfter > 0 && f.sendCalls > f.failAfter {
		return errors.New("stream gone")
	}
	f.out = append(f.out, fr)
	return nil
}

func (f *fakeStream) Recv() (*pb.ServerFrame, error) {
	select {
	case fr := <-f.in:
		return fr, nil
	case <-f.done:
		return nil, errors.New("stream closed")
	}
}

func (f *fakeStream) exec(e *pb.Exec) { f.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_Exec{Exec: e}} }
func (f *fakeStream) close()          { f.closeOnce.Do(func() { close(f.done) }) }
func (f *fakeStream) sent() []*pb.WorkerFrame {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*pb.WorkerFrame(nil), f.out...)
}

// serveResult is a running Serve. err is valid only once done is closed — the
// close is what publishes it, so reading it after a receive on done is race-free.
type serveResult struct {
	done chan struct{}
	err  error
}

// serveJoinGrace bounds how long a test waits for Serve to return once its stream
// has closed. Teardown is a cancel, a channel close and two WaitGroups; whole
// seconds are already an enormous margin, and the point of the bound is to fail
// with a clear message instead of hanging the binary until go test's global
// timeout.
const serveJoinGrace = 5 * time.Second

// serve starts Serve on its own goroutine and — the part that matters — registers
// the cleanup that JOINS it.
//
// EVERY test in this package that starts Serve must go through this, and the
// reason is not tidiness (#173 item 5). Before it, tests launched Serve and
// simply ended: a teardown deadlock, or a WaitGroup that never reached zero, left
// a goroutine wedged forever while `go test` still printed PASS. That is not
// hypothetical — deleting the cancelConn() call that precedes close(queue) in
// Serve (so the heartbeat producer never returns) leaves 14 of this file's 15
// tests passing. Joining here converts every one of them into a witness.
//
// It also subsumes the trailing st.close() those tests used to end with, so a test
// body now closes the stream only when the CLOSE ITSELF is the thing under test.
func serve(t *testing.T, s *session.Session, st *fakeStream) *serveResult {
	t.Helper()
	sv := &serveResult{done: make(chan struct{})}
	go func() {
		defer close(sv.done)
		sv.err = s.Serve(context.Background(), st)
	}()
	t.Cleanup(func() {
		st.close()
		select {
		case <-sv.done:
		case <-time.After(serveJoinGrace):
			// Errorf, not Fatalf: FailNow from a cleanup function would skip the
			// remaining cleanups, and the leaked goroutine is worth reporting
			// alongside whatever else the test found, not instead of it.
			t.Errorf("Serve did not return within %v of the stream closing: teardown is wedged "+
				"(a producer still enqueuing, or a WaitGroup that never reaches zero) and its "+
				"goroutine has leaked", serveJoinGrace)
		}
	})
	return sv
}

// wait blocks until Serve returns and yields its error. why names what the test
// expected to end the session, so a timeout message says which teardown wedged.
func (sv *serveResult) wait(t *testing.T, why string) error {
	t.Helper()
	select {
	case <-sv.done:
		return sv.err
	case <-time.After(serveJoinGrace):
		t.Fatalf("Serve did not return within %v %s", serveJoinGrace, why)
		return nil
	}
}

// waitFor polls until cond holds or the deadline passes — no sleep-and-hope.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// settle gives a pool goroutine room to release its in-flight slot after its
// terminal frame has already been observed on the wire. runOne enqueues that frame
// on the buffered outbound channel BEFORE it returns, and only then does finish()
// delete the slot — so seeing the frame does not by itself prove the slot is gone.
// accept deliberately consults in-flight AHEAD of the cache (that ordering is what
// stops a duplicate arriving mid-send from being answered twice), which means a
// redelivery sent the instant the frame appears could be coalesced instead of
// reaching the cache. The real work in between is a map delete under a mutex;
// 50ms is a very wide margin for it.
func settle() { time.Sleep(50 * time.Millisecond) }

// scriptedRunner returns a fixed outcome and records the specs it received.
type scriptedRunner struct {
	mu    sync.Mutex
	specs []wexec.Spec
	code  int32
	err   error
	// block, when non-nil, holds Run until closed.
	block chan struct{}
	// chunks, when > 0, makes Run emit that many stdout chunks via sink before
	// any block/ctx handling — used to drive more Sends than outbound can buffer.
	chunks int
}

func (r *scriptedRunner) Run(ctx context.Context, s wexec.Spec, sink wexec.Sink) (int32, error) {
	r.mu.Lock()
	r.specs = append(r.specs, s)
	r.mu.Unlock()
	for i := 0; i < r.chunks; i++ {
		if err := sink.Chunk(pb.Stream_STREAM_STDOUT, []byte("x")); err != nil {
			return -1, err
		}
	}
	if r.block != nil {
		select {
		case <-r.block:
		case <-ctx.Done():
			return -1, wexec.ErrAborted
		}
	}
	return r.code, r.err
}

func (r *scriptedRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.specs)
}

func testConfig() session.Config {
	return session.Config{
		SandboxID:     "sbx-test-1",
		Image:         "img:dev",
		Trust:         "untrusted",
		Capabilities:  []string{"bash"},
		MaxConcurrent: 2,
		Heartbeat:     20 * time.Millisecond, // fast, so the test does not wait 15s
	}
}

// terminalFor finds the End/ExecError frame for reqID among what was sent.
func terminalFor(frames []*pb.WorkerFrame, reqID uint64) *pb.WorkerFrame {
	for _, f := range frames {
		if e := f.GetEnd(); e != nil && e.GetReqId() == reqID {
			return f
		}
		if e := f.GetError(); e != nil && e.GetReqId() == reqID {
			return f
		}
	}
	return nil
}

func TestHelloIsFirstFrameAndHonest(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)

	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })
	first := st.sent()[0]
	h := first.GetHello()
	if h == nil {
		t.Fatalf("first frame = %+v, want Hello", first)
	}
	if h.GetSandboxId() != "sbx-test-1" || h.GetTrust() != "untrusted" || h.GetImage() != "img:dev" {
		t.Errorf("hello = %+v, want the config's values", h)
	}
	if h.GetCapacityMax() != 2 {
		t.Errorf("capacity_max = %d, want 2 (the real pool size)", h.GetCapacityMax())
	}
	if len(h.GetCapabilities()) != 1 || h.GetCapabilities()[0] != "bash" {
		t.Errorf("capabilities = %v, want [bash]", h.GetCapabilities())
	}
}

func TestHeartbeatsAreSent(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)

	waitFor(t, "a heartbeat", func() bool {
		for _, f := range st.sent() {
			if f.GetHeartbeat() != nil {
				return true
			}
		}
		return false
	})
}

func TestExecEmitsEndWithExitCode(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{code: 7})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 1, Command: "exit 7", Streaming: true})
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 1) != nil })

	got := terminalFor(st.sent(), 1)
	if got.GetEnd() == nil || got.GetEnd().GetExitCode() != 7 {
		t.Errorf("terminal = %+v, want End{exit_code:7}", got)
	}
}

func TestTimeoutBecomesExecError(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{err: wexec.ErrTimeout})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 2, Command: "sleep 30", TimeoutS: 30, Streaming: true})
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 2) != nil })

	got := terminalFor(st.sent(), 2).GetError()
	if got == nil {
		t.Fatalf("want ExecError, got %+v", terminalFor(st.sent(), 2))
	}
	// The exact string every other harness transport rejects with (spec §4 D2).
	if got.GetMessage() != "timeout:30" {
		t.Errorf("message = %q, want %q", got.GetMessage(), "timeout:30")
	}
}

func TestErrAbortedMapsToSignalledEnd(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{err: wexec.ErrAborted})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 3, Command: "sleep 30", Streaming: true})
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 3) != nil })

	if got := terminalFor(st.sent(), 3).GetEnd(); got == nil || got.GetExitCode() != -1 {
		t.Errorf("terminal = %+v, want End{exit_code:-1}", terminalFor(st.sent(), 3))
	}
}

func TestRunnerErrorBecomesExecError(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{err: errors.New("start bash: no such file")})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 4, Command: "whatever", Streaming: true})
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 4) != nil })

	got := terminalFor(st.sent(), 4).GetError()
	if got == nil || got.GetMessage() != "start bash: no such file" {
		t.Errorf("terminal = %+v, want ExecError carrying the runner error", terminalFor(st.sent(), 4))
	}
}

// A redelivered req_id with the same command re-emits the cached frame and the
// runner is NOT invoked a second time.
func TestRedeliveredReqIDReEmitsWithoutRerunning(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{code: 0}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	e := &pb.Exec{ReqId: 9, Command: "echo x >> log", Streaming: true}
	st.exec(e)
	waitFor(t, "first terminal", func() bool { return terminalFor(st.sent(), 9) != nil })
	if r.count() != 1 {
		t.Fatalf("runner calls = %d, want 1", r.count())
	}
	settle() // the redelivery must reach the cache, not the in-flight slot

	st.exec(&pb.Exec{ReqId: 9, Command: "echo x >> log", Streaming: true})
	waitFor(t, "second terminal", func() bool {
		n := 0
		for _, f := range st.sent() {
			if e := f.GetEnd(); e != nil && e.GetReqId() == 9 {
				n++
			}
		}
		return n >= 2
	})
	if r.count() != 1 {
		t.Errorf("runner calls = %d, want 1: the redelivery re-ran the command", r.count())
	}
}

// A reused req_id carrying a DIFFERENT command must run, not return the cached
// result (spec §3.1).
func TestCollidingReqIDRunsFresh(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{code: 0}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 5, Command: "rm -rf /b", Streaming: true})
	waitFor(t, "first terminal", func() bool { return terminalFor(st.sent(), 5) != nil })
	settle() // the colliding id must reach the cache, not the in-flight slot

	st.exec(&pb.Exec{ReqId: 5, Command: "cat /a", Streaming: true})
	waitFor(t, "second run", func() bool { return r.count() >= 2 })

	r.mu.Lock()
	second := r.specs[1].Command
	r.mu.Unlock()
	if second != "cat /a" {
		t.Errorf("second run command = %q, want %q", second, "cat /a")
	}
}

// sendAttempts reports how many times Send has been called, including calls that
// failed — the only way a test can prove the sender's failure path was entered.
func (f *fakeStream) sendAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sendCalls
}

// pending reports how many frames the session has not yet received. Used to order
// a queued abort ahead of the pool being unblocked.
func (f *fakeStream) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.in)
}

// failSendAfter makes Send succeed n times and fail afterwards, so Hello can get
// through and the failure lands on the dedicated sender goroutine rather than on
// Serve's synchronous Hello send.
func (f *fakeStream) failSendAfter(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAfter = n
	f.sendCalls = 0
}

func (f *fakeStream) abort(reqID uint64) {
	f.in <- &pb.ServerFrame{Msg: &pb.ServerFrame_Abort{Abort: &pb.Abort{ReqId: reqID}}}
}

// Abort must reach a RUNNING exec: the runner's ctx is cancelled, and the
// terminal frame is a signalled End.
func TestAbortCancelsRunningExec(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{})} // blocks until ctx is cancelled
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 1, Command: "sleep 30", Streaming: true})
	waitFor(t, "the runner to start", func() bool { return r.count() == 1 })

	st.abort(1)
	waitFor(t, "terminal frame", func() bool { return terminalFor(st.sent(), 1) != nil })
	if got := terminalFor(st.sent(), 1).GetEnd(); got == nil || got.GetExitCode() != -1 {
		t.Errorf("terminal = %+v, want End{exit_code:-1}", terminalFor(st.sent(), 1))
	}
}

// Abort while an exec is still QUEUED must still produce a terminal frame, and
// must not spawn bash. This is the path that silently vanishes if the abort
// handler removes the slot instead of only cancelling it.
func TestAbortWhileQueuedStillEmitsTerminal(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{})}
	cfg := testConfig()
	cfg.MaxConcurrent = 1 // one slot, so the second exec is forced to queue
	s := session.New(cfg, r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 1, Command: "sleep 30", Streaming: true})
	waitFor(t, "the first exec to occupy the pool", func() bool { return r.count() == 1 })
	st.exec(&pb.Exec{ReqId: 2, Command: "echo queued", Streaming: true})

	st.abort(2) // abort the queued one

	// Establish the ordering before unblocking the pool. st.abort only BUFFERS the
	// frame, so releasing the worker straight away lets it dequeue exec 2 and pass
	// runOne's ctx.Err() check before recvLoop has processed the abort at all —
	// after which both <-r.block and <-ctx.Done() are ready inside the runner and
	// select picks at random. That is a defect in this test's sequencing, not in the
	// session: in production an abort landing as an exec starts legitimately yields
	// "started, then killed" (End{-1} via ErrAborted), which the wire contract
	// permits. "Never spawned" is only guaranteed when the abort provably precedes
	// the dequeue, which is what these two lines establish.
	waitFor(t, "the abort frame to be delivered", func() bool { return st.pending() == 0 })
	time.Sleep(50 * time.Millisecond) // let recvLoop's abortReq land before the pool frees up
	close(r.block)

	waitFor(t, "a terminal frame for the queued exec", func() bool {
		return terminalFor(st.sent(), 2) != nil
	})
	if got := terminalFor(st.sent(), 2).GetEnd(); got == nil || got.GetExitCode() != -1 {
		t.Errorf("terminal for req_id 2 = %+v, want End{exit_code:-1}", terminalFor(st.sent(), 2))
	}
	// It must never have run: only the first exec should have reached the runner.
	r.mu.Lock()
	ran := len(r.specs)
	r.mu.Unlock()
	if ran != 1 {
		t.Errorf("runner saw %d execs, want 1: the aborted-while-queued exec was spawned", ran)
	}
}

// Abort for a req_id the worker never saw is a no-op — no frame at all (spec §8).
func TestAbortUnknownReqIDIsNoOp(t *testing.T) {
	st := newFakeStream()
	s := session.New(testConfig(), &scriptedRunner{})
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.abort(999)
	// Give the loop room to (incorrectly) emit something.
	time.Sleep(100 * time.Millisecond)
	if got := terminalFor(st.sent(), 999); got != nil {
		t.Errorf("sent %+v for an unknown req_id, want nothing", got)
	}
}

// Overflow must be refused immediately rather than blocking the recv loop: a
// blocked dispatch would deadlock, since the Abort that frees the queue sits
// behind it in the same stream.
func TestQueueOverflowIsRefusedNotBlocking(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{})}
	cfg := testConfig()
	cfg.MaxConcurrent = 1
	s := session.New(cfg, r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	// 1 running + QueueCap queued + 1 too many.
	total := uint64(session.QueueCap + 2)
	for i := uint64(1); i <= total; i++ {
		st.exec(&pb.Exec{ReqId: i, Command: "sleep 30", Streaming: true})
	}

	waitFor(t, "a busy refusal", func() bool {
		for _, f := range st.sent() {
			if e := f.GetError(); e != nil && e.GetMessage() == "busy: queue full" {
				return true
			}
		}
		return false
	})

	// The recv loop must still be alive: an abort for the running exec lands.
	st.abort(1)
	waitFor(t, "the aborted exec's terminal frame", func() bool {
		return terminalFor(st.sent(), 1) != nil
	})
	close(r.block)
}

// When the stream dies, Serve returns the recv error and stops cleanly rather
// than leaking its pool or heartbeat goroutines.
func TestServeReturnsOnStreamError(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{})}
	s := session.New(testConfig(), r)
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 1, Command: "sleep 30", Streaming: true})
	waitFor(t, "the runner to start", func() bool { return r.count() == 1 })

	st.close() // the stream is gone
	if err := sv.wait(t, "of the stream dying: an in-flight exec was not cancelled on disconnect"); err == nil {
		t.Error("Serve returned nil, want the recv error")
	}
}

// The cache outlives a connection, which is what makes reconnect → dedup work
// at all (spec §5, §6.2).
func TestCacheSurvivesReconnect(t *testing.T) {
	r := &scriptedRunner{code: 0}
	s := session.New(testConfig(), r)

	first := newFakeStream()
	firstServe := serve(t, s, first)
	waitFor(t, "hello", func() bool { return len(first.sent()) >= 1 })
	st1exec := &pb.Exec{ReqId: 4, Command: "echo x >> log", Streaming: true}
	first.exec(st1exec)
	waitFor(t, "first terminal", func() bool { return terminalFor(first.sent(), 4) != nil })
	// Join the first connection before opening the second: the point of the test is
	// that the CACHE outlives a connection, which only means anything if the first
	// Serve has actually finished rather than still running alongside the second.
	first.close()
	firstServe.wait(t, "of the first connection closing, before the reconnect")

	second := newFakeStream()
	serve(t, s, second)
	waitFor(t, "second hello", func() bool { return len(second.sent()) >= 1 })
	second.exec(&pb.Exec{ReqId: 4, Command: "echo x >> log", Streaming: true})
	waitFor(t, "re-emitted terminal", func() bool { return terminalFor(second.sent(), 4) != nil })

	if r.count() != 1 {
		t.Errorf("runner calls = %d across both connections, want 1", r.count())
	}
}

// The sender goroutine's failure path. Two things make this test real rather than
// an accidental duplicate of TestServeReturnsOnStreamError:
//
//   - Heartbeats are pushed out of the way and the close is gated on an observed
//     second Send attempt, so the test cannot pass without the sender having
//     actually failed. (Gated on the attempt count, since a failing Send still
//     counts as an attempt.)
//   - The runner emits far more frames than outbound can buffer. A sender that
//     returned on its first error instead of continuing to drain would block the
//     producer forever, so Serve would never return and this test would time out
//     rather than quietly pass.
//
// What it does NOT witness, despite the name: teardown in general. A failing Send
// makes the sender call cancelConn() itself, which ends the heartbeat producer as
// a side effect — so this test passes even with Serve's own cancelConn() before
// close(queue) deleted, the very deadlock it looks like it would catch. Its
// coverage is the sender's drain-after-failure behaviour specifically, and the
// join that serve() now registers is what covers the rest (#173 item 5).
func TestSendFailureDoesNotWedgeTeardown(t *testing.T) {
	st := newFakeStream()
	st.failSendAfter(1) // Hello succeeds; every later frame fails inside the sender
	r := &scriptedRunner{chunks: 3 * session.QueueCap}
	cfg := testConfig()
	cfg.Heartbeat = time.Hour // the chunks drive the failure, not a heartbeat race
	s := session.New(cfg, r)
	sv := serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 1, Command: "echo hi", Streaming: true})
	waitFor(t, "the sender to attempt a post-Hello frame (and fail it)", func() bool {
		return st.sendAttempts() >= 2
	})

	st.close() // the stream dies; teardown must finish despite a failing sender
	sv.wait(t, "of the stream dying: the sender stopped draining and a producer wedged")
}

// A duplicate delivery of a req_id whose original is still RUNNING must be
// silently coalesced: exactly one terminal frame for that id, carrying the real
// result. A refusal frame here would race the original's own terminal frame, and
// a caller keyed on req_id would settle it as failed and then discard the result
// of a command that actually ran.
func TestDuplicateInFlightIsCoalesced(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{}), code: 3}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 5, Command: "sleep 1", Streaming: true})
	waitFor(t, "the runner to start", func() bool { return r.count() == 1 })
	st.exec(&pb.Exec{ReqId: 5, Command: "sleep 1", Streaming: true}) // duplicate, still in flight

	time.Sleep(200 * time.Millisecond) // let the duplicate be (incorrectly) refused
	close(r.block)

	waitFor(t, "the original's terminal frame", func() bool { return terminalFor(st.sent(), 5) != nil })
	n := 0
	for _, f := range st.sent() {
		if e := f.GetEnd(); e != nil && e.GetReqId() == 5 {
			n++
		}
		if e := f.GetError(); e != nil && e.GetReqId() == 5 {
			n++
		}
	}
	if n != 1 {
		t.Errorf("terminal frames for req_id 5 = %d, want exactly 1", n)
	}
	if got := terminalFor(st.sent(), 5).GetEnd(); got == nil || got.GetExitCode() != 3 {
		t.Errorf("terminal = %+v, want End{exit_code:3} from the original run", terminalFor(st.sent(), 5))
	}
	if r.count() != 1 {
		t.Errorf("runner calls = %d, want 1: the duplicate re-ran the command", r.count())
	}
}

// A req_id already IN FLIGHT, redelivered with a DIFFERENT command, is a collision
// rather than a redelivery: req_id is only probabilistically unique across harness
// replicas — two replicas collide on drawing the same salt (spec §3.1) — and while
// the original is incomplete the cache cannot catch it, so the in-flight slot's
// fingerprint is the only guard. Coalescing it would swallow the
// other replica's command outright — it would never run and never get a frame.
// Refusing it cannot be a second terminal frame for the same logical exec,
// precisely because it is a different one.
func TestCollidingDuplicateWhileInFlightIsRefused(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{block: make(chan struct{}), code: 0}
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	st.exec(&pb.Exec{ReqId: 5, Command: "cat /a", Streaming: true})
	waitFor(t, "the runner to start", func() bool { return r.count() == 1 })

	// Same id, different command, original still running.
	st.exec(&pb.Exec{ReqId: 5, Command: "rm -rf /b", Streaming: true})
	waitFor(t, "the collision refusal", func() bool {
		f := terminalFor(st.sent(), 5)
		return f != nil && f.GetError() != nil
	})
	if got := terminalFor(st.sent(), 5).GetError().GetMessage(); !strings.Contains(got, "collision") {
		t.Errorf("refusal message = %q, want it to name the req_id collision", got)
	}
	// The colliding command must not have been run behind the original, and the
	// original must not have been disturbed.
	if n := r.count(); n != 1 {
		t.Errorf("runner calls = %d, want 1: the refused command must not run", n)
	}
	r.mu.Lock()
	firstCmd := r.specs[0].Command
	r.mu.Unlock()
	if firstCmd != "cat /a" {
		t.Errorf("running exec = %q, want the original %q", firstCmd, "cat /a")
	}

	close(r.block)
}

// A signalled exit — End{-1} with NO error, which is what the runner reports when
// the child is SIGKILLed while the run context is still live (an OOM-kill, or an
// external kill) — must be emitted but never cached. Caching it would poison the
// req_id: every later redelivery would answer -1 without re-running a command whose
// real outcome was never determined.
func TestSignalledExitIsNotCached(t *testing.T) {
	st := newFakeStream()
	r := &scriptedRunner{code: -1} // signalled: code < 0, err == nil
	s := session.New(testConfig(), r)
	serve(t, s, st)
	waitFor(t, "hello", func() bool { return len(st.sent()) >= 1 })

	oomed := func() *pb.Exec { return &pb.Exec{ReqId: 11, Command: "big-alloc", Streaming: true} }
	st.exec(oomed())
	waitFor(t, "first terminal", func() bool { return terminalFor(st.sent(), 11) != nil })
	if got := terminalFor(st.sent(), 11).GetEnd(); got == nil || got.GetExitCode() != -1 {
		t.Fatalf("terminal = %+v, want End{exit_code:-1}", terminalFor(st.sent(), 11))
	}
	settle() // the redelivery must reach the cache lookup, not the in-flight slot

	st.exec(oomed())
	waitFor(t, "the redelivery to re-run", func() bool { return r.count() >= 2 })
	if n := r.count(); n != 2 {
		t.Errorf("runner calls = %d, want 2: the signalled exit was cached", n)
	}
}
