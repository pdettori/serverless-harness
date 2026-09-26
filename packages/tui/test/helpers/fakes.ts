import type { ControlPlaneApi, CredentialDescriptor } from '../../src/api/types.js';

export function credential(
  name: string,
  over: Partial<CredentialDescriptor> = {},
): CredentialDescriptor {
  return {
    name,
    kind: 'bearer',
    consumer: 'inference',
    destination: { hosts: [] },
    binding: { header: 'Authorization', format: 'Bearer {token}' },
    endpoint: `https://${name}.example/v1`,
    ...over,
  };
}

export function fakeControlPlane(
  over: Partial<ControlPlaneApi> = {},
): ControlPlaneApi & { calls: string[] } {
  const calls: string[] = [];
  const defaults: ControlPlaneApi = {
    healthz: async () => undefined,
    readyz: async () => undefined,
    startDeviceAuth: async () => ({
      deviceCode: 'd',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    }),
    pollDeviceAuth: async () => 'pending',
    me: async () => ({ subject: 'github:1', tenant: 't', roles: [] }),
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    createSession: async () => ({ sessionId: 's-new', token: 'st', expiresAt: 4_000_000_000 }),
    getSession: async (id) => ({
      sessionId: id,
      owner: 'github:1',
      tenant: 't',
      createdAt: 0,
      state: 'active',
      lastTurnAt: null,
      turns: 0,
    }),
    deleteSession: async () => 'deleted',
    mintSessionToken: async () => ({ token: 'st2', expiresAt: 4_000_000_000 }),
    listCredentials: async () => [],
    putCredential: async () => undefined,
    deleteCredential: async () => undefined,
  };
  const merged = { ...defaults, ...over };
  const recorded = Object.fromEntries(
    Object.entries(merged).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        calls.push(k);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as ControlPlaneApi;
  return Object.assign(recorded, { calls });
}
