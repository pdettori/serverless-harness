import { describe, it, expect } from 'vitest';
import { blockingSecrets, scanEntriesForSecrets, SecretScanError } from '../src/secret-scan.js';

const e = (path: string, body: string) => ({ path, content: Buffer.from(body) });

describe('scanEntriesForSecrets — structural rules BLOCK', () => {
  it('is clean for ordinary prose', () => {
    expect(
      scanEntriesForSecrets([e('skills/a/SKILL.md', 'read the docs\napi keys matter')]),
    ).toEqual([]);
  });

  it('blocks an AWS access key id, with path, 1-based line and severity', () => {
    const f = scanEntriesForSecrets([e('context/MEMORY.md', 'note\nAKIAIOSFODNN7EXAMPLE\n')]);
    expect(f).toEqual([
      { path: 'context/MEMORY.md', line: 2, rule: 'aws-access-key-id', severity: 'blocking' },
    ]);
  });

  it('blocks a private key block', () => {
    const f = scanEntriesForSecrets([e('a.pem', '-----BEGIN RSA PRIVATE KEY-----')]);
    expect(f[0]).toMatchObject({ rule: 'private-key-block', severity: 'blocking' });
  });

  it('blocks a GitHub token', () => {
    const f = scanEntriesForSecrets([e('x.md', `ghp_${'a'.repeat(36)}`)]);
    expect(f[0]).toMatchObject({ rule: 'github-token', severity: 'blocking' });
  });

  it('reports every blocking hit, not just the first', () => {
    const f = scanEntriesForSecrets([
      e('a.md', 'AKIAIOSFODNN7EXAMPLE'),
      e('b.md', `ghp_${'b'.repeat(36)}`),
    ]);
    expect(f.map((x) => x.path)).toEqual(['a.md', 'b.md']);
    expect(f.every((x) => x.severity === 'blocking')).toBe(true);
  });

  it('skips binary-looking entries rather than emitting noise', () => {
    expect(scanEntriesForSecrets([{ path: 'x.png', content: Buffer.from([0, 1, 2, 0]) }])).toEqual(
      [],
    );
  });
});

describe('scanEntriesForSecrets — heuristic rules WARN, never block', () => {
  // These cases are why the heuristic is not blocking. Measured against a real ~/.claude, the
  // heuristic produced 11 hits and every one was a false positive; the structural rules produced
  // none. A blocking heuristic would refuse essentially every promotion.
  it('warns, not blocks, on an assigned api key', () => {
    const f = scanEntriesForSecrets([e('x.md', 'api_key = "s3cr3t-value-long-enough"')]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'assigned-secret', severity: 'warning' });
  });

  it('does not fire on the bare phrase', () => {
    expect(scanEntriesForSecrets([e('x.md', 'the api key is rotated monthly')])).toEqual([]);
  });

  it('warns, not blocks, on an Authorization bearer header', () => {
    const f = scanEntriesForSecrets([e('x.md', 'Authorization: Bearer abcdef0123456789abcdef')]);
    expect(f[0]).toMatchObject({ rule: 'bearer-token', severity: 'warning' });
  });

  it('suppresses documentation placeholders entirely', () => {
    for (const body of [
      'api_key = "your-api-key-here"',
      'apiKey: "<YOUR_KEY_HERE>"',
      'password = "changeme-please"',
      'token = "example-token-value"',
    ]) {
      expect(scanEntriesForSecrets([e('doc.md', body)])).toEqual([]);
    }
  });

  it('warns rather than blocks on code that merely looks like an assignment', () => {
    // Real cases measured in installed skills: the value char class accepts dotted identifiers.
    for (const body of ['const TOKEN = crypto.randomUUID', 'apiKey = process.env.ANTHROPIC_KEY']) {
      const f = scanEntriesForSecrets([e('scripts/server.cjs', body)]);
      expect(f.every((x) => x.severity === 'warning')).toBe(true);
    }
  });
});

describe('blockingSecrets', () => {
  it('selects only the blocking subset', () => {
    const f = scanEntriesForSecrets([
      e('a.md', 'AKIAIOSFODNN7EXAMPLE'),
      e('b.md', 'api_key = "s3cr3t-value-long-enough"'),
    ]);
    expect(f).toHaveLength(2);
    expect(blockingSecrets(f).map((x) => x.rule)).toEqual(['aws-access-key-id']);
  });

  it('is empty when only warnings are present, so promotion may proceed', () => {
    const f = scanEntriesForSecrets([e('b.md', 'api_key = "s3cr3t-value-long-enough"')]);
    expect(blockingSecrets(f)).toEqual([]);
  });
});

describe('SecretScanError', () => {
  it('carries the findings and names the first path in its message', () => {
    const err = new SecretScanError([
      { path: 'context/MEMORY.md', line: 2, rule: 'r', severity: 'blocking' },
    ]);
    expect(err.findings).toHaveLength(1);
    expect(err.message).toContain('context/MEMORY.md:2');
  });
});
