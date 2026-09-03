import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createClient } from 'redis';
import {
  buildBundle,
  hasErrors,
  renderPreflight,
  serializeLockfile,
  SecretScanError,
} from '@sh/config-bundle';
import { putBundle, type BundleRedisLike } from './config-store.js';
import { LOCKFILE_OUT, parsePromoteArgs, promoteInputs, readInventory } from './promote.js';

/** Write the lockfile to the filesystem. */
function writeLockfile(cwd: string, lockfile: ReturnType<typeof serializeLockfile>): void {
  const lockPath = join(cwd, LOCKFILE_OUT);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, lockfile);
}

async function main(): Promise<void> {
  const args = parsePromoteArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const inventory = readInventory(args.sandboxImage, cwd);

  const result = buildBundle(
    promoteInputs({
      cwd,
      home: homedir(),
      args,
      ...(inventory ? { inventory } : {}),
      versions: {
        pi: process.env.SH_PI_VERSION ?? 'unknown',
        harness: process.env.SH_HARNESS_VERSION ?? '0.0.0',
      },
    }),
  );

  console.log(
    `  resolved   ${result.lockfile.skills.length + result.lockfile.dropped.length} skills`,
  );
  console.log(`  travels    ${result.lockfile.skills.length}`);
  console.log(`  dropped    ${result.lockfile.dropped.length}`);
  for (const d of result.lockfile.dropped) console.log(`             ${d.name}  (${d.reason})`);
  console.log(
    `  context    ${result.lockfile.context.length} file(s), ${result.lockfile.memory.length} memory file(s)`,
  );
  const secretWarnings = result.findings.filter((f) => f.code === 'possible_secret');
  console.log(
    `  secrets    no blocking findings` +
      (secretWarnings.length ? `, ${secretWarnings.length} warning(s) — see below` : ''),
  );
  console.log(`  entry      ${result.lockfile.entry}`);
  console.log('');
  console.log(renderPreflight(result.findings));
  console.log('');

  if (hasErrors(result.findings)) {
    console.error('promote aborted: preflight found errors (see above)');
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(
      `  bundle     ${result.digest}  (${result.tar.length} bytes, --dry-run: not uploaded)`,
    );
    console.log(`  lockfile   ${LOCKFILE_OUT}  (--dry-run: not written)`);
    return;
  }

  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  try {
    const { uploaded } = await putBundle(
      client as unknown as BundleRedisLike,
      result.digest,
      result.tar,
    );
    writeLockfile(cwd, serializeLockfile(result.lockfile));
    console.log(
      `  bundle     ${result.digest}  (${result.tar.length} bytes, ${uploaded ? 'uploaded' : 'unchanged — upload skipped'})`,
    );
    console.log(`  lockfile   ${LOCKFILE_OUT}`);
    console.log('');
    console.log(
      `dispatch with:  {"sessionId":"<run>/<item>","kind":"prompt","prompt":"…","configRef":"${result.digest}"}`,
    );
  } finally {
    await client.quit();
  }
}

main().catch((err) => {
  if (err instanceof SecretScanError) {
    // Only structural credential formats reach here; heuristic hits are warnings in the report.
    console.error(`promote BLOCKED — ${err.message}`);
    for (const f of err.findings) console.error(`  ${f.path}:${f.line}  ${f.rule}`);
    console.error('\nRemove the credential or add the file to your deny-list, then re-run.');
    process.exit(3);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
