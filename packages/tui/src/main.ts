import { main } from './cli.js';

const ac = new AbortController();
process.once('SIGINT', () => ac.abort());

process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s + '\n') },
  { signal: ac.signal },
);
