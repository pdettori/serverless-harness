import { describe, expect, it } from 'vitest';
import {
  credentialFields,
  toPutRequest,
  validateCredential,
} from '../src/views/overlays/credential-form.js';

const base = { name: 'anthropic', kind: 'bearer', consumer: 'inference', hosts: '', endpoint: '' };

describe('credentialFields', () => {
  it('shows only the secret fields of the chosen kind', () => {
    const visible = (values: Record<string, string>) =>
      credentialFields()
        .filter((f) => !f.visible || f.visible(values))
        .map((f) => f.key);
    expect(visible(base)).toEqual(['name', 'kind', 'consumer', 'hosts', 'endpoint', 'token']);
    expect(visible({ ...base, kind: 'basic', consumer: 'sandbox-egress' })).toEqual([
      'name',
      'kind',
      'consumer',
      'hosts',
      'username',
      'password',
    ]);
    expect(visible({ ...base, kind: 'sigv4' })).toContain('secretPairs');
  });

  it('masks every secret field', () => {
    for (const f of credentialFields().filter((f) =>
      ['token', 'password', 'key', 'accessToken', 'secretPairs'].includes(f.key),
    )) {
      expect(f.masked, f.key).toBe(true);
    }
  });
});

describe('validateCredential', () => {
  it('accepts a valid inference credential', () => {
    expect(validateCredential({ ...base, token: 'x' })).toBeUndefined();
  });

  it.each([
    [{ ...base, name: 'Bad_Name' }, /lower-case letters, digits and dashes/],
    [{ ...base, consumer: 'nope' }, /consumer must be one of/],
    [{ ...base, kind: 'basic' }, /inference credential needs a single-secret kind/],
  ])('rejects %j', (values, message) => {
    expect(validateCredential(values)).toMatch(message);
  });
});

describe('toPutRequest', () => {
  it('builds the request for a known kind', () => {
    expect(
      toPutRequest({
        ...base,
        hosts: 'api.anthropic.com, gw.example',
        endpoint: 'https://gw.example/v1',
        token: 'sk-x',
      }),
    ).toEqual({
      // notsecret
      name: 'anthropic',
      req: {
        kind: 'bearer',
        consumer: 'inference',
        destination: { hosts: ['api.anthropic.com', 'gw.example'] },
        endpoint: 'https://gw.example/v1',
        secret: { token: 'sk-x' }, // notsecret
      },
    });
  });

  it('parses key=value pairs for an unknown kind and drops the endpoint for other consumers', () => {
    expect(
      toPutRequest({
        ...base,
        kind: 'sigv4',
        consumer: 'sandbox-egress',
        endpoint: 'ignored',
        secretPairs: 'accessKey=a, secretKey=b=c',
      }).req,
    ).toEqual({
      kind: 'sigv4',
      consumer: 'sandbox-egress',
      destination: { hosts: [] },
      secret: { accessKey: 'a', secretKey: 'b=c' },
    });
  });
});
