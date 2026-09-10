import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KEK_BYTES, credentialAad, kekFromBase64, open, seal } from '../src/envelope.js';

const KEK = randomBytes(KEK_BYTES); // generated per run -- never a committed key
const OTHER = randomBytes(KEK_BYTES);

describe('seal/open', () => {
  it('round-trips a secret', () => {
    const sealed = seal(KEK, 'github:1234', 'my-anthropic', 'sk-live-abc');
    expect(open(KEK, 'github:1234', 'my-anthropic', sealed)).toBe('sk-live-abc');
  });

  it('never emits the plaintext in the sealed form', () => {
    const sealed = seal(KEK, 'github:1234', 'my-anthropic', 'sk-live-abc');
    expect(sealed).not.toContain('sk-live-abc');
    expect(Buffer.from(sealed).toString('base64')).not.toContain('sk-live-abc');
  });

  it('is versioned, so a later Vault/ESO backend is distinguishable at rest', () => {
    expect(seal(KEK, 'github:1', 'a', 'x').startsWith('v1.')).toBe(true);
  });

  it('uses a fresh iv per seal, so two seals of one value differ', () => {
    const a = seal(KEK, 'github:1', 'a', 'same');
    const b = seal(KEK, 'github:1', 'a', 'same');
    expect(a).not.toBe(b);
    expect(open(KEK, 'github:1', 'a', b)).toBe('same');
  });

  it('round-trips a long value and one with non-ASCII bytes', () => {
    const long = 'x'.repeat(8192);
    expect(open(KEK, 'github:1', 'a', seal(KEK, 'github:1', 'a', long))).toBe(long);
    const utf8 = 'ключ-🔐-token';
    expect(open(KEK, 'github:1', 'a', seal(KEK, 'github:1', 'a', utf8))).toBe(utf8);
  });
});

describe('the AAD buys a real property, not tidiness', () => {
  it('fails to open Alice ciphertext relabelled as Bob', () => {
    // An attacker who can WRITE Secrets still cannot move Alice's row into Bob's and spend her key
    // (spec §6.5). This is the whole reason the AAD exists.
    const sealed = seal(KEK, 'github:alice', 'my-anthropic', 'sk-alice');
    expect(() => open(KEK, 'github:bob', 'my-anthropic', sealed)).toThrow(/decrypt/i);
  });

  it('fails to open one credential name as another', () => {
    const sealed = seal(KEK, 'github:alice', 'my-anthropic', 'sk-alice');
    expect(() => open(KEK, 'github:alice', 'github-work', sealed)).toThrow(/decrypt/i);
  });

  it('binds subject and name in one unambiguous string', () => {
    expect(credentialAad('github:1234', 'my-anthropic').toString()).toBe(
      'github:1234|my-anthropic',
    );
  });
});

describe('failure modes', () => {
  it('fails with the wrong KEK', () => {
    const sealed = seal(KEK, 'github:1', 'a', 'x');
    expect(() => open(OTHER, 'github:1', 'a', sealed)).toThrow(/decrypt/i);
  });

  it('fails on a flipped ciphertext bit (GCM authenticates, it does not just encrypt)', () => {
    const sealed = seal(KEK, 'github:1', 'a', 'hello');
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 0x01;
    parts[3] = ct.toString('base64url');
    expect(() => open(KEK, 'github:1', 'a', parts.join('.'))).toThrow(/decrypt/i);
  });

  it('rejects an unknown version prefix', () => {
    expect(() => open(KEK, 'github:1', 'a', 'v9.aa.bb.cc')).toThrow(/version/i);
  });

  it('rejects a structurally broken sealed value', () => {
    for (const broken of ['', 'v1', 'v1.a', 'v1.a.b', 'v1.a.b.c.d']) {
      expect(() => open(KEK, 'github:1', 'a', broken), broken).toThrow();
    }
  });

  it('rejects a KEK of the wrong length rather than padding it', () => {
    expect(() => kekFromBase64(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => kekFromBase64(undefined)).toThrow(/SH_CREDENTIAL_KEK/);
    expect(() => kekFromBase64('not-base64!!!')).toThrow(/32 bytes/);
  });

  it('accepts a correctly sized base64 KEK', () => {
    const raw = randomBytes(KEK_BYTES);
    expect(kekFromBase64(raw.toString('base64')).equals(raw)).toBe(true);
  });
});
