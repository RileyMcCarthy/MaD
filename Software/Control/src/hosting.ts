/**
 * Where this copy of the app is hosted, and the other released versions.
 *
 * The public site serves every MaD Control release side by side:
 *   /<repo>/app/v0.4.0/   one release, frozen as it shipped
 *   /<repo>/app/          redirects to the latest release, keeping the route
 *   /<repo>/app/versions.json   the releases on offer, newest first, with the protocol each speaks
 *   /<repo>/app/firmware/       the latest firmware release, shared by all
 * (assembled by tools/assemble-pages-app.mts). A dev server or any other
 * unversioned build has none of this: its base is the hosting root itself.
 */

import type { AppForFirmware } from '@/domain';

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
  /** Newest first. `protocolVersion` is missing for releases built before it was recorded. */
  versions: { version: string; publishedAt: string | null; protocolVersion?: number }[];
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

/**
 * The newest release that speaks `protocol`, or null when none on the list is
 * known to: a release built before the protocol was recorded never matches.
 */
export function appForProtocol(list: HostedVersions, protocol: number): string | null {
  return list.versions.find((v) => v.protocolVersion === protocol)?.version ?? null;
}

/**
 * Where an app too old for firmware on `protocol` can send the operator.
 * `list` is the release list beside this release: undefined while it is on
 * its way, null when it could not be read. An unversioned copy (`hosted`
 * false) has no list beside it and no release to offer.
 */
export function appForFirmware(
  hosted: boolean,
  list: HostedVersions | null | undefined,
  protocol: number,
): AppForFirmware {
  if (!hosted) return { kind: 'none' };
  if (list === undefined) return { kind: 'looking' };
  if (list === null) return { kind: 'unknown' };
  const version = appForProtocol(list, protocol);
  return version === null ? { kind: 'none' } : { kind: 'release', version };
}
