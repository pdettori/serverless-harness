import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption ON TOP of the Kubernetes Secret (spec §6.5). A Secret is base64, not
 * encryption, and namespace `get secrets` reads it -- so a namespace-wide secret read must yield
 * ciphertext. The KEK lives in a SEPARATE Secret mounted only into the control plane, making "read
 * the credential store" and "read the key that opens it" two distinct RBAC subjects.
 *
 * AES-256-GCM, and the AAD is `subject|name`. The AAD is free and buys a real property: an attacker
 * who can WRITE Secrets still cannot relabel Alice's ciphertext into Bob's row and spend her key,
 * because decryption then fails. Unambiguous because a credential name is restricted to
 * [a-z0-9][a-z0-9-]* (credential-store.ts), so no `|` can appear in either half.
 *
 * Wire form: `v1.<b64url iv>.<b64url tag>.<b64url ciphertext>`. Versioned so that moving to Vault
 * or External Secrets behind CredentialStore (spec §6.6) is distinguishable at rest rather than a
 * guess about which bytes are which.
 */
export const KEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const VERSION = 'v1';

export function kekFromBase64(raw: string | undefined): Buffer {
  if (raw === undefined || raw === '') {
    throw new Error('SH_CREDENTIAL_KEK is not set; the control plane cannot store credentials');
  }
  const kek = Buffer.from(raw, 'base64');
  if (kek.length !== KEK_BYTES) {
    throw new Error(
      `SH_CREDENTIAL_KEK must decode to exactly ${KEK_BYTES} bytes (got ${kek.length})`,
    );
  }
  return kek;
}

export function credentialAad(subject: string, name: string): Buffer {
  return Buffer.from(`${subject}|${name}`);
}

export function seal(kek: Buffer, subject: string, name: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(credentialAad(subject, name));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function open(kek: Buffer, subject: string, name: string, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4) throw new Error('sealed credential is malformed');
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error(`unsupported sealed credential version '${version}'`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(credentialAad(subject, name));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // One opaque message for every failure -- wrong KEK, wrong subject, wrong name, tampered
    // ciphertext, or malformed IV/tag in the sealed format. Distinguishing them would tell a
    // caller which part of the input it guessed right.
    throw new Error(`failed to decrypt credential '${name}'`);
  }
}
