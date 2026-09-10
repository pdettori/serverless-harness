import { beforeEach, describe, expect, it } from 'vitest';
import type { CpError } from '../src/errors.js';
import { checkExchangeAuth, exchangeCredential, placeholderFor } from '../src/exchange.js';
import { HANDLERS, type CpDeps } from '../src/handlers.js';
import { makeDeps, ctx, alice, codeOf, seedCredential } from './helpers/deps.js';

/** Create a session through the real handler and return its session token. */
async function sessionToken(d: CpDeps, id = 'sid-fixed'): Promise<string> {
  const res = await HANDLERS.createSession!(ctx({ principal: alice, body: {} }), {
    ...d,
    newId: () => id,
  });
  return (res.body as { token: string }).token;
}

describe('checkExchangeAuth', () => {
  it('accepts the configured token', () => {
    expect(() => checkExchangeAuth('shared-abc', 'shared-abc')).not.toThrow(); // notsecret
  });

  it('rejects a wrong token', () => {
    expect(() => checkExchangeAuth('nope', 'shared-abc')).toThrow(
      // notsecret
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('rejects EVERY call when no token is configured — fail-closed, not fail-open', () => {
    // /internal/credentials hands out real credentials, so an unconfigured deployment must reject
    // everything rather than accept anything (spec §5.3.1, plan gap #3).
    expect(() => checkExchangeAuth('anything', undefined)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(() => checkExchangeAuth(undefined, undefined)).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(() => checkExchangeAuth('', '')).toThrow(
      expect.objectContaining({ code: 'unauthorized' }),
    );
  });

  it('never puts the presented value in the error', () => {
    // A request with the wrong token gets 401 and is NOT logged with the presented value (spec §5.3.1).
    try {
      checkExchangeAuth('super-secret-guess', 'shared-abc'); // notsecret
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-guess'); // notsecret
    }
  });
});

describe('placeholderFor', () => {
  it('is inert and names the subject', () => {
    expect(placeholderFor('github:1234')).toBe('sh-placeholder-github:1234');
  });

  it('differs per subject, so an injector can tell two tenants apart', () => {
    expect(placeholderFor('github:1')).not.toBe(placeholderFor('github:2'));
  });
});

describe('exchangeCredential', () => {
  let d: CpDeps;
  beforeEach(async () => {
    d = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: undefined }, // notsecret
    });
    await seedCredential(d); // github:1234 / my-anthropic, endpoint https://litellm.internal/v1
  });

  it('returns the subject`s own credential in direct mode when no injector is configured', async () => {
    const token = await sessionToken(d);
    expect(await exchangeCredential(token, d)).toEqual({
      mode: 'direct',
      anthropicAuthToken: 'sk-fake', // notsecret
      anthropicBaseUrl: 'https://litellm.internal/v1',
      sessionId: 'sid-fixed',
      subject: 'github:1234',
    });
  });

  it('returns a placeholder, not the real key, whenever the deployment has an injector', async () => {
    // Placeholder mode WINS whenever an injector exists, so adding one strictly NARROWS what the
    // harness may hold, and MU3 deletes direct mode outright (spec §3.6).
    const withInjector = makeDeps({
      credentials: d.credentials,
      index: d.index,
      signer: d.signer,
      verifyKeys: d.verifyKeys,
      config: { exchangeToken: 'shared-abc', injectorConfigured: true }, // notsecret
    });
    const token = await sessionToken(withInjector, 'sid-inj');
    const res = await exchangeCredential(token, withInjector);
    expect(res.mode).toBe('placeholder');
    expect(res.anthropicAuthToken).toBe('sh-placeholder-github:1234');
    expect(res.anthropicAuthToken).not.toContain('sk-fake'); // notsecret
  });

  it('rejects an api-scoped token — only a session token may drive a turn', async () => {
    const api = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['api'],
      ttlSeconds: 3600,
    });
    expect(await codeOf(() => exchangeCredential(api, d))).toBe('token_invalid');
  });

  it('rejects an expired token', async () => {
    const expired = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      sid: 'sid-fixed',
      ttlSeconds: 300,
      now: Math.floor(d.now() / 1000) - 400,
    });
    expect(await codeOf(() => exchangeCredential(expired, d))).toBe('token_expired');
  });

  it('rejects a token whose sid names no session', async () => {
    const orphan = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      sid: 'never-created',
      ttlSeconds: 300,
      now: Math.floor(d.now() / 1000),
    });
    expect(await codeOf(() => exchangeCredential(orphan, d))).toBe('session_not_found');
  });

  it('rejects a token with no sid at all', async () => {
    const noSid = d.signer.mint({
      sub: 'github:1234',
      tenant: 'github:1234',
      roles: [],
      scope: ['turn:write'],
      ttlSeconds: 300,
    });
    expect(await codeOf(() => exchangeCredential(noSid, d))).toBe('token_invalid');
  });

  it("refuses a token whose subject is not the session's owner", async () => {
    // A valid token minted for Alice must not exchange against a session owned by Bob, even though
    // both facts are individually true (spec §8.1, session-drive row).
    const token = await sessionToken(d);
    const rec = (await d.index.get('sid-fixed'))!;
    await d.index.create({ ...rec, owner: 'github:9999' });
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('session_not_found');
  });

  it('refuses a tombstoned session, so a deleted session cannot start a new turn', async () => {
    const token = await sessionToken(d);
    await d.index.tombstone('sid-fixed');
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('session_not_found');
  });

  it('refuses when the recorded credential has since been deleted', async () => {
    // The second of the two policy points that make MU1 fail closed before P5's sentinel lands: the
    // exchange REFUSES rather than reaching for the deployment's own key (spec §3.5).
    const token = await sessionToken(d);
    await d.credentials.delete('github:1234', 'my-anthropic');
    expect(await codeOf(() => exchangeCredential(token, d))).toBe('credential_required');
  });

  it('refuses with the deployment key present in the environment', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deployment-ambient'; // notsecret
    try {
      const token = await sessionToken(d);
      await d.credentials.delete('github:1234', 'my-anthropic');
      expect(await codeOf(() => exchangeCredential(token, d))).toBe('credential_required');
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('falls back to the operator key only when explicitly allowed, and audits it', async () => {
    // The operator fallback RELOCATES rather than disappearing (spec §6.4): the decision is made by
    // the trusted tier, is attributable to a subject, and is logged -- never an env fallback in the
    // harness, where a control-plane bug would quietly borrow a neighbour's identity.
    const deps = makeDeps({
      withStreams: true,
      config: {
        exchangeToken: 'shared-abc', // notsecret
        allowOperatorFallback: true,
        operatorInferenceToken: 'sk-operator', // notsecret
        defaultInferenceEndpoint: 'https://default.gateway/v1',
      },
    });
    const streams = deps.streams;
    await seedCredential(deps);
    const token = await sessionToken(deps);
    await deps.credentials.delete('github:1234', 'my-anthropic');
    const res = await exchangeCredential(token, deps);
    expect(res).toMatchObject({
      mode: 'direct',
      anthropicAuthToken: 'sk-operator', // notsecret
      anthropicBaseUrl: 'https://default.gateway/v1',
    });
    expect(
      (streams.get('sh:cp:audit') ?? []).some((r) => r.decision === 'operator_fallback_used'),
    ).toBe(true);
  });

  it('refuses when the fallback is allowed but no operator key is configured', async () => {
    const fb = makeDeps({
      config: { exchangeToken: 'shared-abc', allowOperatorFallback: true }, // notsecret
    });
    await seedCredential(fb);
    const token = await sessionToken(fb);
    await fb.credentials.delete('github:1234', 'my-anthropic');
    expect(await codeOf(() => exchangeCredential(token, fb))).toBe('credential_required');
  });

  it('resolves the base url from the credential, else the deployment default', async () => {
    const noEndpoint = makeDeps({
      config: { exchangeToken: 'shared-abc', defaultInferenceEndpoint: 'https://fallback/v1' }, // notsecret
    });
    await seedCredential(noEndpoint, 'github:1234', 'my-anthropic', { endpoint: null });
    const res = await exchangeCredential(await sessionToken(noEndpoint), noEndpoint);
    expect(res.anthropicBaseUrl).toBe('https://fallback/v1');
  });

  it('REFUSES rather than returning an undefined base url', async () => {
    // If anthropicBaseUrl came back undefined, run-turn.ts:313's `||` would fall through to
    // process.env.ANTHROPIC_BASE_URL and, failing that, applyModelGateway would return a model
    // carrying Bearer <subject's token> with NO baseUrl override -- sending one user's gateway token
    // to the default Anthropic endpoint. That is a misdirected secret, not a degraded request
    // (spec §6.2, §9.2).
    const noBase = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    await seedCredential(noBase, 'github:1234', 'my-anthropic', { endpoint: null });
    expect(await codeOf(async () => exchangeCredential(await sessionToken(noBase), noBase))).toBe(
      'endpoint_unresolved',
    );
  });

  it('audits the issue by credential NAME, never by value', async () => {
    const deps = makeDeps({
      withStreams: true,
      config: { exchangeToken: 'shared-abc' }, // notsecret
    });
    const streams = deps.streams;
    await seedCredential(deps);
    await exchangeCredential(await sessionToken(deps), deps);
    const rows = streams.get('sh:cp:audit') ?? [];
    expect(
      rows.some((r) => r.decision === 'credential_issued' && r.credential === 'my-anthropic'),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('sk-fake'); // notsecret
  });
});

describe('the exchangeCredential handler', () => {
  it('401s unless the router marked the request exchange-authorized', async () => {
    const d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    await seedCredential(d);
    const token = await sessionToken(d);
    expect(await codeOf(() => HANDLERS.exchangeCredential!(ctx({ body: { token } }), d))).toBe(
      'unauthorized',
    );
    await expect(
      HANDLERS.exchangeCredential!(ctx({ body: { token }, exchangeAuthorized: true }), d),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('requires a token in the body', async () => {
    const d = makeDeps({ config: { exchangeToken: 'shared-abc' } }); // notsecret
    expect(
      await codeOf(() =>
        HANDLERS.exchangeCredential!(ctx({ body: {}, exchangeAuthorized: true }), d),
      ),
    ).toBe('invalid_request');
  });
});

describe('readyz', () => {
  it('is ok when the index answers', async () => {
    const d = makeDeps();
    expect((await HANDLERS.readyz!(ctx(), d)).status).toBe(200);
  });

  it('503s when Redis is down, while /v1/credentials stays up', async () => {
    // Spec §9.2: Redis down => session routes 503, credentials keep working, because §7.1 put them in
    // different stores.
    const down = makeDeps({
      index: {
        ...makeDeps().index,
        getRuntime: async () => {
          throw new Error('ECONNREFUSED');
        },
        get: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as never,
    });
    expect(await codeOf(() => HANDLERS.readyz!(ctx(), down))).toBe('redis_unavailable');
    await expect(HANDLERS.listCredentials!(ctx({ principal: alice }), down)).resolves.toMatchObject(
      {
        status: 200,
      },
    );
  });
});
