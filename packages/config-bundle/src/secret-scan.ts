import type { SecretFinding, TarEntry } from './types.js';

/**
 * TWO TIERS, and the split is empirical rather than aesthetic.
 *
 * Measured over a real `~/.claude` (61 bundled skills, 586 files), the structural rules below
 * produced ZERO hits, while a single heuristic rule ("<word>: <12+ chars>") produced 11 — every
 * one a false positive. Seven were documentation placeholders; four were CODE, e.g.
 * `TOKEN = crypto.randomUUID` and `apiKey = process.env...`, which match because the value
 * character class contains `.` and so accepts dotted identifiers. Two of those sit inside the
 * `brainstorming` skill itself.
 *
 * A blocking heuristic would therefore refuse essentially every promotion on day one, and a gate
 * nobody can pass gets bypassed or deleted. So structural rules BLOCK and the heuristic WARNS.
 *
 * Entropy scoring stays rejected as YAGNI for the same reason the heuristic is demoted: it
 * collides with prose and code, and its false positives are the expensive direction.
 */
const BLOCKING_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
];

/** Heuristic: real signal sometimes, prose or code often. Warns, never blocks. */
const WARNING_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    rule: 'assigned-secret',
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{12,}/i,
  },
];

/**
 * Obvious documentation placeholders. Suppresses ~7 of the 11 measured heuristic hits, so the
 * warning list stays short enough that a human actually reads it.
 */
const PLACEHOLDER =
  /your[_-]?|example|placeholder|change[_-]?me|xxx+|dummy|fake|<[^>]+>|\bREPLACE|\bTODO|\.\.\./i;

/** Heuristic: a NUL byte means binary, so line-based scanning would be noise. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

/**
 * Every secret-shaped hit, each tagged `blocking` or `warning`. Empty means clean.
 * Blocking hits must stop promotion; warnings are reported and promotion continues.
 */
export function scanEntriesForSecrets(entries: TarEntry[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const entry of entries) {
    if (looksBinary(entry.content)) continue;
    const lines = entry.content.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const blocking = BLOCKING_RULES.find((r) => r.re.test(line));
      if (blocking) {
        findings.push({ path: entry.path, line: i + 1, rule: blocking.rule, severity: 'blocking' });
        continue; // one finding per line is enough
      }
      const warn = WARNING_RULES.find((r) => r.re.test(line));
      if (warn) {
        const matched = warn.re.exec(line)?.[0] ?? '';
        if (PLACEHOLDER.test(matched)) continue; // documentation example, not a credential
        findings.push({ path: entry.path, line: i + 1, rule: warn.rule, severity: 'warning' });
      }
    }
  }
  return findings;
}

/** Only the blocking subset. */
export function blockingSecrets(findings: SecretFinding[]): SecretFinding[] {
  return findings.filter((f) => f.severity === 'blocking');
}

/** Thrown by buildBundle when a BLOCKING hit is present. Promotion must not proceed. */
export class SecretScanError extends Error {
  constructor(readonly findings: SecretFinding[]) {
    const first = findings[0];
    super(
      `secret scan blocked promotion: ${findings.length} blocking finding(s), first at ` +
        `${first?.path}:${first?.line} (${first?.rule})`,
    );
    this.name = 'SecretScanError';
  }
}
