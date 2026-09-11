// A minimal worker with the same IPC contract as sh-worker (§3.9), whose handler streams.
// Used to prove that a handed-off socket carries a chunked/SSE response with no supervisor
// involvement — the property that makes socket hand-off different from byte proxying.
import { createServer } from 'node:http';

let inFlight = 0;
const report = () => process.send({ type: 'load', inFlight });

const server = createServer((req, res) => {
  if (req.url === '/stream') {
    inFlight += 1;
    report();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: chunk-${n}\n\n`);
      if (n === 3) {
        clearInterval(timer);
        res.end('data: done\n\n');
        inFlight -= 1;
        report();
      }
    }, 20);
    res.on('close', () => clearInterval(timer));
    return;
  }
  // Echo the worker's pid and the routing header, so a test can tell WHICH worker served it
  // and whether the head survived the hand-off.
  const body = JSON.stringify({
    pid: process.pid,
    url: req.url,
    sid: req.headers['x-sh-session-id'] ?? null,
  });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
});

process.send({ type: 'ready', pid: process.pid });
process.on('message', (msg, handle) => {
  if (msg.type === 'conn') {
    if (msg.head) handle.unshift(Buffer.from(msg.head, 'base64'));
    // Part of the §3.9 contract this fixture claims to implement (see worker.ts's accept()):
    // the supervisor credits +1 per handed-off CONNECTION, so a connection that carries no
    // turn must still report on close or the estimate ratchets up permanently and the pool
    // wedges into 429s. Absolute count, never a decrement.
    handle.once('close', () => report());
    server.emit('connection', handle);
    return;
  }
  if (msg.type === 'drain') {
    process.send({ type: 'draining' });
    server.closeIdleConnections();
  }
});
process.on('disconnect', () => process.exit(0));
