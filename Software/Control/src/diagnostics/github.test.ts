import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearToken,
  getToken,
  hasToken,
  looksLikeToken,
  redactToken,
  setToken,
  verifyToken,
  GitHubError,
} from './github';
import { logger, logSnapshot, clearLog, sanitize } from './log';

const FAKE = 'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz0123456789ABCDEFGH';

// The unit environment is Node, which has no localStorage; the app's guarded
// access returns null there. Provide a minimal one so the store is exercised.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  clearToken();
  clearLog();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearToken();
});

describe('token storage', () => {
  it('round-trips a token', () => {
    expect(hasToken()).toBe(false);
    setToken(FAKE);
    expect(getToken()).toBe(FAKE);
    expect(hasToken()).toBe(true);
  });

  it('trims whitespace from a paste', () => {
    setToken(`  ${FAKE}\n`);
    expect(getToken()).toBe(FAKE);
  });

  it('clears cleanly', () => {
    setToken(FAKE);
    clearToken();
    expect(getToken()).toBeNull();
    expect(hasToken()).toBe(false);
  });
});

describe('looksLikeToken', () => {
  it('recognises fine-grained and classic tokens', () => {
    expect(looksLikeToken(FAKE)).toBe(true);
    expect(looksLikeToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
  });

  it('rejects obvious non-tokens', () => {
    expect(looksLikeToken('hunter2')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });

  it('is not confused by repeated calls (no lastIndex leakage)', () => {
    // A /g regex used with .test() advances lastIndex between calls, which
    // would make every other check spuriously fail.
    expect(looksLikeToken(FAKE)).toBe(true);
    expect(looksLikeToken(FAKE)).toBe(true);
    expect(looksLikeToken(FAKE)).toBe(true);
  });
});

describe('credential redaction', () => {
  it('scrubs a token from arbitrary text', () => {
    expect(redactToken(`Bad credentials for ${FAKE}`)).not.toContain(FAKE);
    expect(redactToken(`Bad credentials for ${FAKE}`)).toContain('<redacted-credential>');
  });

  it('scrubs a classic token and an Authorization header', () => {
    expect(redactToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('ghp_abcdef');
    expect(redactToken(`Authorization: Bearer ${FAKE}`)).not.toContain(FAKE);
  });

  it('leaves ordinary text alone', () => {
    expect(redactToken('the gantry stalls at 40mm')).toBe('the gantry stalls at 40mm');
  });
});

describe('the token cannot reach the session log', () => {
  it('is scrubbed from a logged message', () => {
    // This is the property that matters: a bundle goes into a PUBLIC issue, so
    // a token echoed into a log entry would be published.
    logger('app').error('boom', `request failed with ${FAKE}`);
    const dumped = JSON.stringify(logSnapshot());
    expect(dumped).not.toContain(FAKE);
  });

  it('is scrubbed from logged data values', () => {
    logger('app').info('probe', undefined, { header: `Bearer ${FAKE}`, note: 'fine' });
    const dumped = JSON.stringify(logSnapshot());
    expect(dumped).not.toContain(FAKE);
    expect(dumped).toContain('fine');
  });

  it('is scrubbed by the sanitizer directly', () => {
    expect(JSON.stringify(sanitize({ token: FAKE }))).not.toContain(FAKE);
  });
});

describe('GitHubError', () => {
  it('never carries a token in its message', () => {
    const err = new GitHubError(`Bad credentials: ${FAKE}`, 401, 'unauthorized');
    expect(err.message).not.toContain(FAKE);
  });
});

describe('verifyToken', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;
  const fail = (status: number, message = 'nope') =>
    ({
      ok: false,
      status,
      statusText: message,
      json: async () => ({ message }),
      headers: new Headers(),
    }) as Response;

  it('reports the login and repo access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/user')) return ok({ login: 'riley' });
        if (url.includes('/repos/')) return ok({ has_issues: true });
        return ok([]);
      }),
    );
    const check = await verifyToken(FAKE);
    expect(check).toEqual({ login: 'riley', canFileIssues: true, canCreateGists: true });
  });

  it('reports no repo access rather than throwing', async () => {
    // A fine-grained token can authenticate perfectly and still not reach this
    // repo — the user needs to be told that, not shown a raw 404.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/user')) return ok({ login: 'riley' });
        if (url.includes('/repos/')) return fail(404);
        return ok([]);
      }),
    );
    const check = await verifyToken(FAKE);
    expect(check.canFileIssues).toBe(false);
    expect(check.login).toBe('riley');
  });

  it('reports missing gist scope without failing the whole check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/user')) return ok({ login: 'riley' });
        if (url.includes('/repos/')) return ok({ has_issues: true });
        return fail(403);
      }),
    );
    const check = await verifyToken(FAKE);
    expect(check.canFileIssues).toBe(true);
    expect(check.canCreateGists).toBe(false);
  });

  it('surfaces a bad token as unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(401, 'Bad credentials')));
    await expect(verifyToken(FAKE)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('classifies an exhausted rate limit as rate-limited, not forbidden', async () => {
    // A 403 with no remaining quota is a rate limit; telling the user to fix
    // their scopes would send them the wrong way entirely.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 403,
            statusText: 'rate limited',
            json: async () => ({ message: 'API rate limit exceeded' }),
            headers: new Headers({ 'x-ratelimit-remaining': '0' }),
          }) as Response,
      ),
    );
    await expect(verifyToken(FAKE)).rejects.toMatchObject({ code: 'rate-limited' });
  });

  it('reports a network failure distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(verifyToken(FAKE)).rejects.toMatchObject({ code: 'network' });
  });
});
