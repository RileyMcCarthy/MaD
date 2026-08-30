/**
 * Direct GitHub filing from the browser, using a token the user supplies.
 *
 * `api.github.com` sends `access-control-allow-origin: *` and accepts an
 * `Authorization` header, so a page can create gists and issues with no backend
 * at all. What a browser *cannot* do is complete an OAuth exchange —
 * `github.com/login/oauth/*` sends no CORS headers — so the token has to come
 * from the user rather than a sign-in flow.
 *
 * With a token the attachment problem disappears: the full bundle goes up as a
 * secret gist and the issue links it, instead of asking someone to drag a file
 * into a form (the step where reports otherwise die).
 *
 * SECURITY: the token is a credential held in `localStorage`. It is never
 * logged, never included in a diagnostics bundle, and never sent anywhere but
 * `api.github.com` — see `redactToken` and the guards in `log.ts`.
 */

import { logger, redactCredentials } from './log';

const log = logger('app');

const API = 'https://api.github.com';
const TOKEN_KEY = 'mad:githubToken';

/** Owner/repo that issues are filed against. */
export const ISSUE_OWNER = 'RileyMcCarthy';
export const ISSUE_REPO_NAME = 'MaD';

/** Token shapes GitHub issues, for recognising a paste. */
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * Scrub anything token-shaped. Delegates to the logger's redactor so there is
 * exactly one definition of "looks like a credential" in the app.
 */
export function redactToken(text: string): string {
  return redactCredentials(text);
}

export function looksLikeToken(value: string): boolean {
  TOKEN_PATTERN.lastIndex = 0;
  return TOKEN_PATTERN.test(value.trim());
}

/* ------------------------------------------------------------- token store -- */

export function getToken(): string | null {
  try {
    const t = globalThis.localStorage?.getItem(TOKEN_KEY);
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token.trim());
  } catch {
    // Private mode / quota. The caller surfaces the failure.
  }
}

export function clearToken(): void {
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    // Nothing useful to do.
  }
}

export function hasToken(): boolean {
  return getToken() !== null;
}

/* ------------------------------------------------------------------ client -- */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Lets the UI offer a targeted remedy rather than a generic failure. */
    readonly code: 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'network' | 'other',
  ) {
    // A GitHub error body can echo a request that contained the token.
    super(redactToken(message));
    this.name = 'GitHubError';
  }
}

function classify(status: number): GitHubError['code'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  return 'other';
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    throw new GitHubError(
      err instanceof Error ? err.message : 'network request failed',
      0,
      'network',
    );
  }

  if (!res.ok) {
    // A 403 with no remaining rate limit is a rate limit, not a permission
    // problem — telling the user to fix their scopes would send them the wrong way.
    const remaining = res.headers.get('x-ratelimit-remaining');
    const code = res.status === 403 && remaining === '0' ? 'rate-limited' : classify(res.status);
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      // Non-JSON error body; the status text will do.
    }
    throw new GitHubError(detail, res.status, code);
  }
  return (await res.json()) as T;
}

export interface TokenCheck {
  login: string;
  /** Whether the token can actually create an issue on the target repo. */
  canFileIssues: boolean;
  /** Whether gists can be created — the bundle upload needs this. */
  canCreateGists: boolean;
}

/**
 * Verify a token before storing it.
 *
 * Checked against the real repo rather than just `/user`, because a
 * fine-grained token can authenticate perfectly and still have no access to
 * this repository — a failure that would otherwise only appear when someone
 * tries to file their first report.
 */
export async function verifyToken(token: string): Promise<TokenCheck> {
  const user = await request<{ login: string }>('/user', token);
  let canFileIssues = false;
  try {
    const repo = await request<{ permissions?: { push?: boolean; pull?: boolean }; has_issues?: boolean }>(
      `/repos/${ISSUE_OWNER}/${ISSUE_REPO_NAME}`,
      token,
    );
    // Read access plus issues enabled is enough to open one; `push` is not
    // required and demanding it would reject perfectly good reporter tokens.
    canFileIssues = repo.has_issues !== false;
  } catch (err) {
    if (err instanceof GitHubError && (err.code === 'not-found' || err.code === 'forbidden')) {
      canFileIssues = false;
    } else {
      throw err;
    }
  }

  // Gist scope cannot be probed without creating one, so infer from the listing
  // endpoint — it requires the same scope on classic tokens.
  let canCreateGists = false;
  try {
    await request<unknown[]>('/gists?per_page=1', token);
    canCreateGists = true;
  } catch {
    canCreateGists = false;
  }

  return { login: user.login, canFileIssues, canCreateGists };
}

export interface FiledIssue {
  number: number;
  htmlUrl: string;
  gistUrl?: string;
}

/**
 * Upload the bundle as a **secret** gist.
 *
 * Secret rather than public: it is unlisted and unsearchable, reachable only by
 * the link in the issue. It still lives under the reporter's account, which is
 * the right place for their own diagnostic data.
 */
export async function uploadBundleGist(
  token: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const gist = await request<{ html_url: string }>('/gists', token, {
    method: 'POST',
    body: JSON.stringify({
      description: `MaD Control diagnostics — ${fileName}`,
      public: false,
      files: { [fileName]: { content: contents } },
    }),
  });
  return gist.html_url;
}

export async function createIssue(
  token: string,
  title: string,
  body: string,
  labels: string[] = ['bug', 'app'],
): Promise<FiledIssue> {
  const issue = await request<{ number: number; html_url: string }>(
    `/repos/${ISSUE_OWNER}/${ISSUE_REPO_NAME}/issues`,
    token,
    { method: 'POST', body: JSON.stringify({ title, body, labels }) },
  );
  log.info('bug-report', 'issue created', { number: issue.number });
  return { number: issue.number, htmlUrl: issue.html_url };
}
