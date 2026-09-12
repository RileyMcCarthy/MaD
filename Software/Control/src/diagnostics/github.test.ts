import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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
  behaviour(
    {
      id: 'diag.github-token-round-trips',
      covers: 'src/diagnostics/github.ts#setToken',
      given: 'a GitHub personal access token is saved',
      then: 'a saved GitHub token can be read back and is reported as present',
    },
    () => {
      expect(hasToken()).toBe(false);
      setToken(FAKE);
      expect(getToken()).toBe(FAKE);
      expect(hasToken()).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.github-token-trims-paste',
      covers: 'src/diagnostics/github.ts#setToken',
      given: 'a GitHub token pasted with leading spaces and a trailing newline',
      then: 'surrounding whitespace is stripped from a pasted GitHub token before it is stored',
      why: 'a paste from GitHub often includes a trailing newline',
    },
    () => {
      setToken(`  ${FAKE}\n`);
      expect(getToken()).toBe(FAKE);
    },
  );

  behaviour(
    {
      id: 'diag.github-token-clears',
      covers: 'src/diagnostics/github.ts#clearToken',
      given: 'a stored GitHub token is cleared',
      then: 'clearing the GitHub token leaves none stored',
    },
    () => {
      setToken(FAKE);
      clearToken();
      expect(getToken()).toBeNull();
      expect(hasToken()).toBe(false);
    },
  );
});

describe('looksLikeToken', () => {
  behaviour(
    {
      id: 'diag.github-recognises-token-shapes',
      covers: 'src/diagnostics/github.ts#looksLikeToken',
      given: 'a fine-grained github_pat_ token and a classic ghp_ token',
      then: 'both fine-grained and classic GitHub token shapes are recognised as tokens',
    },
    () => {
      expect(looksLikeToken(FAKE)).toBe(true);
      expect(looksLikeToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.github-rejects-non-tokens',
      covers: 'src/diagnostics/github.ts#looksLikeToken',
      given: 'ordinary text and an empty string',
      then: 'ordinary text and an empty string are not treated as GitHub tokens',
    },
    () => {
      expect(looksLikeToken('hunter2')).toBe(false);
      expect(looksLikeToken('')).toBe(false);
    },
  );

  behaviour(
    {
      id: 'diag.github-token-check-repeatable',
      covers: 'src/diagnostics/github.ts#looksLikeToken',
      given: 'the same GitHub token is checked three times in a row',
      then: 'checking the same GitHub token repeatedly still recognises it every time',
      why: 'a check that failed on the second paste of the same token would reject a valid token',
    },
    () => {
      // A /g regex used with .test() advances lastIndex between calls, which
      // would make every other check spuriously fail.
      expect(looksLikeToken(FAKE)).toBe(true);
      expect(looksLikeToken(FAKE)).toBe(true);
      expect(looksLikeToken(FAKE)).toBe(true);
    },
  );
});

describe('credential redaction', () => {
  behaviour(
    {
      id: 'diag.github-redacts-token-from-text',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'an error string that embeds a GitHub token',
      then: 'a GitHub token embedded in arbitrary text is replaced with a redaction marker',
      why: 'a diagnostics bundle is published in a public issue, so a GitHub token must never survive into it',
    },
    () => {
      expect(redactToken(`Bad credentials for ${FAKE}`)).not.toContain(FAKE);
      expect(redactToken(`Bad credentials for ${FAKE}`)).toContain('<redacted-credential>');
    },
  );

  behaviour(
    {
      id: 'diag.github-redacts-classic-and-bearer',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'a classic ghp_ token and an Authorization Bearer header carrying a fine-grained token',
      then: 'both a classic GitHub token and a Bearer authorization header are redacted',
    },
    () => {
      expect(redactToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('ghp_abcdef');
      expect(redactToken(`Authorization: Bearer ${FAKE}`)).not.toContain(FAKE);
    },
  );

  behaviour(
    {
      id: 'diag.github-redact-leaves-ordinary-text',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'a sentence with no token in it',
      then: 'ordinary text with no GitHub token is left unchanged',
    },
    () => {
      expect(redactToken('the gantry stalls at 40mm')).toBe('the gantry stalls at 40mm');
    },
  );
});

describe('the token cannot reach the session log', () => {
  behaviour(
    {
      id: 'diag.github-token-scrubbed-from-log-message',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'a crash-log message that embeds a GitHub token',
      then: 'a GitHub token in a crash-log message is stripped before the crash log is exported',
      why: 'a diagnostics bundle is published in a public issue, so a GitHub token echoed into a log entry would be published',
    },
    () => {
      // This is the property that matters: a bundle goes into a PUBLIC issue, so
      // a token echoed into a log entry would be published.
      logger('app').error('boom', `request failed with ${FAKE}`);
      const dumped = JSON.stringify(logSnapshot());
      expect(dumped).not.toContain(FAKE);
    },
  );

  behaviour(
    {
      id: 'diag.github-token-scrubbed-from-log-data',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'a log data object whose header field carries a Bearer GitHub token',
      then: 'a GitHub token in logged data is stripped while neighbouring non-secret fields survive',
    },
    () => {
      logger('app').info('probe', undefined, { header: `Bearer ${FAKE}`, note: 'fine' });
      const dumped = JSON.stringify(logSnapshot());
      expect(dumped).not.toContain(FAKE);
      expect(dumped).toContain('fine');
    },
  );

  behaviour(
    {
      id: 'diag.github-token-scrubbed-by-sanitize',
      covers: 'src/diagnostics/github.ts#redactToken',
      given: 'an object with a GitHub token as a field',
      then: 'preparing an object that holds a GitHub token for the crash log removes the token from the JSON',
    },
    () => {
      expect(JSON.stringify(sanitize({ token: FAKE }))).not.toContain(FAKE);
    },
  );
});

describe('GitHubError', () => {
  behaviour(
    {
      id: 'diag.github-error-never-carries-token',
      covers: 'src/diagnostics/github.ts#GitHubError',
      given: 'a GitHub error constructed with a message that embeds a token',
      then: 'a GitHub error message never contains the GitHub token that caused it',
      why: 'GitHub error bodies can echo a request that contained the token',
    },
    () => {
      const err = new GitHubError(`Bad credentials: ${FAKE}`, 401, 'unauthorized');
      expect(err.message).not.toContain(FAKE);
    },
  );
});

describe('verifyToken', () => {
  /** No `x-oauth-scopes` header — i.e. a fine-grained token, the probe path. */
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

  behaviour(
    {
      id: 'diag.github-verify-reports-login-and-access',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'GitHub accepts the token, the repo has issues, and gists are allowed',
      then: 'verifying a GitHub token reports the account login and that issues and gists can both be created',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.github-verify-missing-repo-access',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'the token authenticates but the repo lookup returns 404',
      then: 'a token that authenticates but cannot see the repo is reported as unable to file issues, with the login still shown',
      why: 'a fine-grained token can authenticate and still not reach this repository, and the user needs to be told that',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.github-verify-missing-gist-scope',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'the token can file issues but gist listing returns 403',
      then: 'a token that cannot create gists is still reported as able to file issues',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.github-verify-unauthorized',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'GitHub rejects the token with 401 Bad credentials',
      then: 'a rejected GitHub token fails verification as unauthorized',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fail(401, 'Bad credentials')));
      await expect(verifyToken(FAKE)).rejects.toMatchObject({ code: 'unauthorized' });
    },
  );

  behaviour(
    {
      id: 'diag.github-verify-rate-limited',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'GitHub returns 403 with zero remaining rate-limit quota',
      then: 'a 403 with an exhausted GitHub rate limit fails verification as rate-limited',
      why: 'a rate limit mistaken for missing permission would send the user to fix the wrong thing',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'diag.github-verify-network-failure',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'the GitHub request fails at the network layer',
      then: 'a network failure while verifying a GitHub token is reported as a network error',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      await expect(verifyToken(FAKE)).rejects.toMatchObject({ code: 'network' });
    },
  );
});

describe('verifyToken with a classic token', () => {
  const okScoped = (body: unknown, scopes: string) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      headers: new Headers({ 'x-oauth-scopes': scopes }),
    }) as Response;

  behaviour(
    {
      id: 'diag.github-classic-trusts-scopes',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'a classic GitHub token whose scope header lists public_repo and gist',
      then: 'a classic GitHub token is verified from its granted scopes in a single request',
      why: 'public_repo reaches any public repository, so one set of instructions works for every user',
    },
    async () => {
      // A classic token states what it can do, so no repo/gist round-trips are
      // needed — and `public_repo` reaches ANY public repo, not just one you own,
      // which is what makes a single set of instructions work for every user.
      const fetchMock = vi.fn(async () => okScoped({ login: 'someone' }, 'public_repo, gist'));
      vi.stubGlobal('fetch', fetchMock);
      const check = await verifyToken(FAKE);
      expect(check).toEqual({ login: 'someone', canFileIssues: true, canCreateGists: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  behaviour(
    {
      id: 'diag.github-classic-repo-scope-files-issues',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'a classic GitHub token whose scope header lists repo and gist',
      then: 'a classic GitHub token with full repo scope is treated as able to file issues',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okScoped({ login: 'someone' }, 'repo, gist')));
      expect((await verifyToken(FAKE)).canFileIssues).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.github-classic-missing-gist-scope',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'a classic GitHub token with public_repo but no gist scope',
      then: 'a classic GitHub token without gist scope is reported as able to file issues and unable to create gists',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okScoped({ login: 'someone' }, 'public_repo')));
      const check = await verifyToken(FAKE);
      expect(check.canFileIssues).toBe(true);
      expect(check.canCreateGists).toBe(false);
    },
  );

  behaviour(
    {
      id: 'diag.github-classic-without-repo-scope',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'a classic GitHub token whose scopes are gist and read:user only',
      then: 'a classic GitHub token without repo or public_repo scope is reported as unable to file issues',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okScoped({ login: 'someone' }, 'gist, read:user')));
      const check = await verifyToken(FAKE);
      expect(check.canFileIssues).toBe(false);
    },
  );

  behaviour(
    {
      id: 'diag.github-classic-empty-scope-header',
      covers: 'src/diagnostics/github.ts#verifyToken',
      given: 'a classic GitHub token whose scope header is empty',
      then: 'a classic GitHub token with an empty scope header is reported as unable to file issues or create gists',
    },
    async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okScoped({ login: 'someone' }, '')));
      const check = await verifyToken(FAKE);
      expect(check.canFileIssues).toBe(false);
      expect(check.canCreateGists).toBe(false);
    },
  );
});
