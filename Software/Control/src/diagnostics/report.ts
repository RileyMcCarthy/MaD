/**
 * "Report a bug" — turn a session into a filed GitHub issue.
 *
 * There is no backend and nowhere to hide a token, so the flow is: download the
 * bundle locally, then open a prefilled issue form the user submits under their
 * own account, attaching the file. Two steps, but zero infrastructure and no
 * credential ever leaves the browser.
 *
 * The URL carries only a compact summary. GitHub rejects very long URLs, so the
 * full log rides as the attachment — `buildIssueUrl` enforces that budget rather
 * than letting a long session silently produce a dead link.
 */

import type { BundleOptions, DiagnosticsBundle } from './exportBundle';
import { logger } from './log';

const log = logger('app');

export const ISSUE_REPO = 'RileyMcCarthy/MaD';
export const ISSUE_TEMPLATE = 'app-bug.yml';

/**
 * Practical ceiling for the issue URL. GitHub starts failing somewhere above
 * 8 KB; 6 KB leaves room for the fields the form adds itself.
 */
export const ISSUE_URL_MAX = 6000;

export interface ReportInput {
  /** What the user says went wrong. */
  summary: string;
  /** Optional reproduction steps. */
  steps?: string;
  /** Attach the raw serial window (opt-in — see BundleOptions). */
  includeSerialTail?: boolean;
}

/** Counter lines worth putting in the issue body without the full log. */
function summariseCounters(bundle: DiagnosticsBundle): string {
  const counters = bundle.log.counters;
  const interesting = Object.entries(counters)
    .filter(([key]) => /error|nack|timeout|fail|trap|stall|jank/i.test(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  if (interesting.length === 0) return 'No errors, NACKs or timeouts recorded.';
  return interesting.map(([key, n]) => `${key}: ${n}`).join('\n');
}

/** The last few error-level entries — usually the actual story. */
function recentErrors(bundle: DiagnosticsBundle, limit = 5): string {
  const errors = bundle.log.entries.filter((e) => e.level === 'error').slice(-limit);
  if (errors.length === 0) return 'None recorded.';
  return errors
    .map((e) => {
      const at = new Date(e.t).toISOString().slice(11, 23);
      return `${at} ${e.cat}/${e.tag} ${e.msg ?? ''}`.trim();
    })
    .join('\n');
}

/**
 * Environment block for the issue body.
 *
 * Deliberately not the raw user-agent string alone — the build identity is what
 * decides whether a report is even actionable.
 */
export function environmentBlock(bundle: DiagnosticsBundle): string {
  return [
    `App: ${bundle.version} (${bundle.gitSha})`,
    `Mode: ${bundle.buildMode}`,
    `Firmware: ${bundle.device.firmwareVersion ?? 'unknown'}`,
    `Connection: ${bundle.device.connection}${bundle.device.responding ? ' (responding)' : ''}`,
    `Web Serial: ${bundle.capabilities.webSerial ? 'yes' : 'no'} · File System Access: ${
      bundle.capabilities.fileSystemAccess ? 'yes' : 'no'
    }`,
    `UA: ${bundle.userAgent}`,
  ].join('\n');
}

/** Fields posted to the issue form, keyed by the template's field ids. */
export function buildIssueFields(
  input: ReportInput,
  bundle: DiagnosticsBundle,
  attachmentName: string,
): Record<string, string> {
  return {
    template: ISSUE_TEMPLATE,
    labels: 'bug,app',
    title: `[app] ${input.summary.slice(0, 80)}`,
    summary: input.summary,
    steps: input.steps?.trim() ? input.steps : '(not provided)',
    environment: environmentBlock(bundle),
    counters: summariseCounters(bundle),
    errors: recentErrors(bundle),
    attachment: attachmentName,
  };
}

/**
 * Build the prefilled issue URL, trimming the longest optional fields until it
 * fits the budget.
 *
 * Trimming order is deliberate: `steps` and `summary` are the user's own words
 * and are dropped last; the derived blocks are reconstructible from the
 * attachment, so they go first.
 */
export function buildIssueUrl(fields: Record<string, string>): string {
  const base = `https://github.com/${ISSUE_REPO}/issues/new`;
  const droppable = ['errors', 'counters', 'environment', 'steps'];

  const render = (f: Record<string, string>): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(f)) {
      if (value !== '') params.set(key, value);
    }
    return `${base}?${params.toString()}`;
  };

  const working = { ...fields };
  let url = render(working);
  for (const key of droppable) {
    if (url.length <= ISSUE_URL_MAX) break;
    if (working[key] === undefined) continue;
    working[key] = '(omitted — see attached diagnostics file)';
    url = render(working);
  }

  // Last resort: a truncated summary still beats a URL GitHub refuses to open.
  if (url.length > ISSUE_URL_MAX && working.summary !== undefined) {
    const overflow = url.length - ISSUE_URL_MAX;
    working.summary = `${working.summary.slice(0, Math.max(40, working.summary.length - overflow - 40))}…`;
    url = render(working);
  }
  return url;
}

/** Timestamped bundle filename, matching what the issue body tells the user to attach. */
export function bundleFileName(now: Date): string {
  return `mad-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ReportResult {
  fileName: string;
  issueUrl: string;
  bundle: DiagnosticsBundle;
}

/**
 * Download the bundle and open the prefilled issue.
 *
 * The download happens first: if the popup is blocked, the user still has the
 * file and the returned URL, so the report is never lost to a blocked tab.
 */
export async function fileBugReport(input: ReportInput): Promise<ReportResult> {
  // Imported at call time, not module scope: `exportBundle` reaches the device
  // client, which constructs a Worker on import. Keeping that out of the graph
  // leaves the URL/field builders pure and independently testable.
  const { buildDiagnosticsBundle } = await import('./exportBundle');
  const opts: BundleOptions = { includeSerialTail: input.includeSerialTail ?? false };
  const bundle = await buildDiagnosticsBundle(opts);
  const fileName = bundleFileName(new Date());

  log.info('bug-report', 'filed', {
    entries: bundle.log.entries.length,
    includeSerialTail: opts.includeSerialTail,
  });

  downloadJson(fileName, bundle);
  const issueUrl = buildIssueUrl(buildIssueFields(input, bundle, fileName));
  window.open(issueUrl, '_blank', 'noopener,noreferrer');
  return { fileName, issueUrl, bundle };
}
