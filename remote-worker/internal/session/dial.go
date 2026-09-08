package session

import (
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

// MaxRecvMsgBytes raises gRPC's 4 MiB default receive limit, which is too small for
// this contract's own write path (#173 item 2).
//
// THE DERIVATION, because the number must not be arbitrary. A write travels as base64
// in Exec.stdin (operations.ts encodes it), and base64 inflates by 4/3. The read path
// is capped at DEFAULT_OUTPUT_CAP = 8 MiB, so the largest readable file becomes an
// 8 MiB × 4/3 ≈ 10.7 MiB Exec. At the 4 MiB default, every file between ~3 MiB and
// 8 MiB was READABLE BUT NOT WRITABLE — and Pi's Edit composes read with write, so
// editing such a file succeeded at reading and then failed. 16 MiB covers the
// inflated read cap with room for the command string and protobuf framing, so write
// capacity is >= read capacity by construction.
//
// BOTH ENDS MUST MOVE TOGETHER, and the worker's must be at least the relay's. The
// relay's ingress limit is what rejects an oversized ExecRequest today, and that
// rejection is contained to one exec. Raising the relay alone would forward the
// payload and move the rejection here — onto the Attach stream, whose death takes
// every concurrent and queued exec with it and forces main.go to re-dial. The
// coupling is pinned across the language boundary by
// packages/k8s-sandbox/test/message-size-coupling.test.ts and behaviourally by
// TestContractAcceptsAnOversizedWritePayload.
//
// Send limits need no change: grpc-go defaults MaxCallSendMsgSize to MaxInt32 and
// grpc-js defaults max_send_message_length to -1, both effectively unlimited.
const MaxRecvMsgBytes = 16 * 1024 * 1024

// DialOptions returns the options every worker connection to the relay must use.
// It exists so tests exercise the SAME configuration production dials with: the
// receive limit above is only meaningful if it is actually applied, and a test that
// built its own option list would prove nothing about main.go.
func DialOptions(creds credentials.TransportCredentials) []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		// Raise the receive ceiling for ServerFrames carrying a large Exec.stdin. This
		// is the relay->worker half of the pair described on MaxRecvMsgBytes.
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(MaxRecvMsgBytes)),
		// PermitWithoutStream: false is deliberate and safe here. The Attach stream is
		// open for the entire time liveness matters, so pinging only while a stream is
		// active loses nothing — and the relay (packages/sandbox-relay) configures no
		// keepalive enforcement policy at all, so this cannot trip a server-side
		// GOAWAY ENHANCE_YOUR_CALM.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: false,
		}),
	}
}
