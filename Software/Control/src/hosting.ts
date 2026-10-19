/**
 * Where this copy of the app is hosted, and the other released versions.
 *
 * The public site serves every MaD Control release side by side:
 *   /<repo>/app/v0.4.0/   one release, frozen as it shipped
 *   /<repo>/app/          redirects to the latest release, keeping the route
 *   /<repo>/app/versions.json   the releases on offer, newest first
 *   /<repo>/app/firmware/       the latest firmware release, shared by all
 * (assembled by tools/assemble-pages-app.mts). A dev server or any other
 * unversioned build has none of this: its base is the hosting root itself.
 */

/** The release this copy is, from its base path; null when not a versioned build. */
export function hostedVersion(baseUrl: string): string | null {
  const m = /\/v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\/$/.exec(baseUrl);
  return m ? m[1] : null;
}

/** The folder shared by all versions: the parent of a versioned base, else the base. */
export function hostingRoot(baseUrl: string): string {
  return hostedVersion(baseUrl) === null ? baseUrl : baseUrl.replace(/v[^/]+\/$/, '');
}

/** The address of `version` of the app, on the same route. */
export function versionUrl(baseUrl: string, version: string, hash = ''): string {
  return `${hostingRoot(baseUrl)}v${version}/${hash}`;
}

export interface HostedVersions {
  latest: string;
  versions: { version: string; publishedAt: string | null }[];
}

function isHostedVersions(value: unknown): value is HostedVersions {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.latest === 'string' &&
    Array.isArray(v.versions) &&
    v.versions.every(
      (e) => typeof e === 'object' && e !== null && typeof (e as { version?: unknown }).version === 'string',
    )
  );
}

/** The released versions next to this one; null for an unversioned build or a missing list. */
export async function fetchHostedVersions(
  baseUrl: string,
  fetchFn: (input: string) => Promise<Response> = (input) => fetch(input),
): Promise<HostedVersions | null> {
  if (hostedVersion(baseUrl) === null) return null;
  try {
    const res = await fetchFn(`${hostingRoot(baseUrl)}versions.json`);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isHostedVersions(body) ? body : null;
  } catch {
    return null;
  }
}
