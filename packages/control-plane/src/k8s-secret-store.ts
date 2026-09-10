import { createHash } from 'node:crypto';
import { open, seal } from './envelope.js';
import {
  buildCreateSecretArgs,
  buildDeleteSecretArgs,
  buildGetSecretArgs,
  buildPatchSecretArgs,
  defaultRunKubectl,
  isAlreadyExists,
  type RunKubectl,
} from './kubectl.js';
import type {
  Consumer,
  CredentialDescriptor,
  CredentialStore,
  StoredCredential,
} from './credential-store.js';

/**
 * Per-user Kubernetes Secrets in a DEDICATED namespace, under envelope encryption (spec §6.5).
 *
 * Redis cannot hold these: it is entirely ephemeral (spec §2.5 -- no PVC, no volume, no appendonly),
 * so a pod bounce would lose every user's key and re-entry after each restart would make the system
 * fragile in its most visible place. Credentials are the one thing that must outlive every session.
 *
 * The Secret NAME is derived from the subject (sha256, 16 hex chars), which is what makes every
 * access a `get` by exact name -- so the runtime Role can omit the `list` verb and a bug or an
 * injection cannot enumerate users. A hash also means object names disclose no logins.
 *
 * Writes are MERGE PATCHES, never `apply`: apply would replace the whole Secret and drop the
 * subject's other credentials, and read-modify-write would lose updates -- the exact failure mode
 * spec §6.6 rejects a single shared Secret over.
 *
 * Per-user Secrets are right at demo and team scale and a known anti-pattern at very large user
 * counts (one etcd object each, with watch and informer cost). The recorded direction is an external
 * manager -- Vault, or External Secrets -- behind the same CredentialStore interface (spec §6.6).
 */
export function subjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 16);
}

export function secretNameFor(subject: string): string {
  return `sh-cred-${subjectHash(subject)}`;
}

const ANNOTATION_PREFIX = 'sh.io';
const FIELDS = ['kind', 'consumer', 'destination', 'binding', 'endpoint'] as const;
const annotationKey = (field: (typeof FIELDS)[number], name: string): string =>
  `${ANNOTATION_PREFIX}/${field}.${name}`;

interface SecretJson {
  metadata?: { annotations?: Record<string, string> };
  data?: Record<string, string>;
}

export class K8sSecretStore implements CredentialStore {
  private readonly namespace: string;
  private readonly kek: Buffer;
  private readonly run: RunKubectl;

  constructor(opts: { namespace: string; kek: Buffer; run?: RunKubectl }) {
    this.namespace = opts.namespace;
    this.kek = opts.kek;
    this.run = opts.run ?? defaultRunKubectl;
  }

  private async fetch(subject: string): Promise<SecretJson | null> {
    const raw = (await this.run(buildGetSecretArgs(secretNameFor(subject), this.namespace))).trim();
    if (!raw) return null; // --ignore-not-found prints nothing
    return JSON.parse(raw) as SecretJson;
  }

  /** Idempotent: the create is attempted every time and AlreadyExists is the expected outcome. */
  private async ensureSecret(subject: string): Promise<void> {
    try {
      await this.run(buildCreateSecretArgs(secretNameFor(subject), this.namespace));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  async put(subject: string, cred: StoredCredential): Promise<void> {
    const { descriptor, secret } = cred;
    await this.ensureSecret(subject);
    const patch = {
      metadata: {
        annotations: {
          [annotationKey('kind', descriptor.name)]: descriptor.kind,
          [annotationKey('consumer', descriptor.name)]: descriptor.consumer,
          [annotationKey('destination', descriptor.name)]: JSON.stringify(
            descriptor.destination.hosts,
          ),
          [annotationKey('binding', descriptor.name)]: JSON.stringify(descriptor.binding),
          // A null clears a stale endpoint left by a previous, inference-flavoured put.
          [annotationKey('endpoint', descriptor.name)]: descriptor.endpoint,
        },
      },
      // stringData, so kubectl does the base64. Read back through `data`, which is base64 -- the
      // asymmetry is kubectl's, and the fake in the test reproduces it on purpose.
      stringData: {
        [descriptor.name]: seal(this.kek, subject, descriptor.name, JSON.stringify(secret)),
      },
    };
    await this.run(
      buildPatchSecretArgs(secretNameFor(subject), this.namespace),
      JSON.stringify(patch),
    );
  }

  async get(subject: string, name: string): Promise<StoredCredential | null> {
    const secret = await this.fetch(subject);
    const sealed = secret?.data?.[name];
    const annotations = secret?.metadata?.annotations ?? {};
    if (!sealed) return null;
    const descriptor = describe(name, annotations);
    if (!descriptor) return null;
    // Throws on a wrong KEK, a wrong subject, or a relabelled ciphertext -- the AAD is what makes
    // "move Alice's row into Bob's" fail rather than succeed (spec §6.5).
    const plaintext = open(this.kek, subject, name, Buffer.from(sealed, 'base64').toString('utf8'));
    return { descriptor, secret: JSON.parse(plaintext) as Record<string, string> };
  }

  /** Descriptors only, from annotations -- so this path never touches the KEK (spec §6.2). */
  async list(subject: string): Promise<CredentialDescriptor[]> {
    const secret = await this.fetch(subject);
    if (!secret) return [];
    const annotations = secret.metadata?.annotations ?? {};
    const out: CredentialDescriptor[] = [];
    for (const name of Object.keys(secret.data ?? {})) {
      const descriptor = describe(name, annotations);
      // A stray data key with no annotations is skipped rather than reported with an invented
      // descriptor: list() reports only what it can actually describe.
      if (descriptor) out.push(descriptor);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(subject: string, name: string): Promise<void> {
    const secret = await this.fetch(subject);
    if (!secret) return; // nothing to do, and creating one to delete from would be absurd
    const patch = {
      metadata: {
        annotations: Object.fromEntries(FIELDS.map((f) => [annotationKey(f, name), null])),
      },
      stringData: { [name]: null },
    };
    await this.run(
      buildPatchSecretArgs(secretNameFor(subject), this.namespace),
      JSON.stringify(patch),
    );
  }
}

/** Rebuild a descriptor from annotations, or null when the required ones are missing/corrupt. */
function describe(name: string, annotations: Record<string, string>): CredentialDescriptor | null {
  const kind = annotations[annotationKey('kind', name)];
  const consumer = annotations[annotationKey('consumer', name)];
  const destination = annotations[annotationKey('destination', name)];
  const binding = annotations[annotationKey('binding', name)];
  if (!kind || !consumer || !destination || !binding) return null;
  try {
    return {
      name,
      kind,
      consumer: consumer as Consumer,
      destination: { hosts: JSON.parse(destination) as string[] },
      binding: JSON.parse(binding) as CredentialDescriptor['binding'],
      endpoint: annotations[annotationKey('endpoint', name)] ?? null,
    };
  } catch {
    return null;
  }
}
