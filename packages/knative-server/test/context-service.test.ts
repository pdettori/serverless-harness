import { afterEach, describe, expect, it, vi } from 'vitest';

import { contextServiceConfigured, createWorkload } from '../src/context-service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Context Service client', () => {
  it('is disabled unless CONTEXT_SERVICE_URL is explicitly set', () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', '');
    expect(contextServiceConfigured()).toBe(false);
  });

  it('creates managed shared storage through the configured service', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example/');
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'demo',
          status: 'provisioning',
          replicas: 3,
          readyReplicas: 0,
          sandboxSelector: 'context.rossoctl.io/pool=demo',
          workspace: { size: '5Gi', accessMode: 'ReadWriteMany', storageClass: 'ibm-scale-csi' },
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    await createWorkload('demo', {
      sandboxes: 3,
      workspace: { shared: true, size: '5Gi', storageClass: 'ibm-scale-csi' },
    });

    expect(fetch.mock.calls[0][0]).toBe('http://context.example/v1/sandbox-pools');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'demo',
      replicas: 3,
      workspace: { size: '5Gi', accessMode: 'ReadWriteMany', storageClass: 'ibm-scale-csi' },
    });
  });

  it('passes an existing read-only claim without managed-workspace fields', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'readers',
          status: 'provisioning',
          replicas: 4,
          readyReplicas: 0,
          sandboxSelector: 'context.rossoctl.io/pool=readers',
          workspace: { claimName: 'mosaic', readOnly: true },
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    await createWorkload('readers', {
      sandboxes: 4,
      workspace: { claimName: 'mosaic', readOnly: true },
    });

    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'readers',
      replicas: 4,
      workspace: { claimName: 'mosaic', readOnly: true },
    });
  });

  it('aborts a Context Service request after the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://context.example');
    vi.stubEnv('CONTEXT_SERVICE_TIMEOUT_MS', '25');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const request = createWorkload('demo', {});
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
  });
});
