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
import { formatTriage } from './triage';
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
  /** Attach the previous page load's log (default on). */
  includePreviousSession?: boolean;
}

/**
 * What a bundle would disclose, for review before anything is published.
 *
 * The report ends up in a public issue, so the person filing it should be able
 * to see the categories of information it carries — not just tick a box. This
 * is derived from a real bundle rather than described from memory, so it cannot
 * drift from what actually gets written.
 */
export interface ReportPreview {
  bundle: DiagnosticsBundle;
  triageText: string;
  sizeBytes: number;
  entryCount: number;
  /** Human-readable lines describing what is included. */
  contents: string[];
  /** Identifying details worth a second look before publishing. */
  disclosures: string[];
}

export async function buildReportPreview(input: ReportInput): Promise<ReportPreview> {
  const { buildDiagnosticsBundle } = await import('./exportBundle');
  const bundle = await buildDiagnosticsBundle({
    includeSerialTail: input.includeSerialTail ?? false,
    includePreviousSession: input.includePreviousSession ?? true,
  });
  const json = JSON.stringify(bundle);

  const contents = [
    `${bundle.log.entries.length} log entries (${(bundle.triage.sessionMs / 1000).toFixed(0)}s session)`,
    `App version ${bundle.version} (${bundle.gitSha}), firmware ${bundle.device.firmwareVersion ?? 'unknown'}`,
  ];
  if (bundle.serialTail) {
    contents.push(
      `${bundle.serialTail.chunks.length} raw serial chunks (${bundle.serialTail.totalRxBytes} bytes received)`,
    );
  }
  if (bundle.previousSession) {
    contents.push(
      `The previous session's log (${bundle.previousSession.entries.length} entries${
        bundle.previousSession.closed ? '' : ', ended unexpectedly'
      })`,
    );
  }

  // Named explicitly: these are the fields that identify a machine or a person,
  // and a checkbox alone is not informed consent for publishing them.
  const disclosures = [`Your browser and OS version (${shortUserAgent(bundle.userAgent)})`];
  if (bundle.device.portLabel) disclosures.push(`The serial adapter's USB id (${bundle.device.portLabel})`);
  const folders = new Set(
    bundle.log.entries
      .filter((e) => e.cat === 'fs' && typeof e.data?.name === 'string')
      .map((e) => String(e.data?.name)),
  );
  if (folders.size > 0) {
    disclosures.push(`Data folder name${folders.size === 1 ? '' : 's'}: ${[...folders].join(', ')}`);
  }
  if (bundle.serialTail) {
    disclosures.push('Raw bytes exchanged with the machine (no sample values or file contents)');
  }

  return {
    bundle,
    triageText: formatTriage(bundle.triage),
    sizeBytes: json.length,
    entryCount: bundle.log.entries.length,
    contents,
    disclosures,
  };
}

/**
 * `Chrome 130 on macOS` rather than the full 120-character UA string.
 *
 * Checked most-specific first: every Chromium UA contains `Chrome`, and
 * Chrome's own contains `Safari`, so a plain alternation reports Edge as
 * Chrome and would quietly misattribute a browser-specific bug.
 */
export function shortUserAgent(ua: string): string {
  const CANDIDATES: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ];
  let name = 'unknown browser';
  for (const [re, label] of CANDIDATES) {
    const m = re.exec(ua);
    if (m) {
      name = `${label} ${m[1]}`;
      break;
    }
  }
  const os = /\((?:Macintosh; )?([^;)]+)/.exec(ua);
  return os ? `${name} on ${os[1].trim()}` : name;
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
    triage: formatTriage(bundle.triage),
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
  const droppable = ['errors', 'counters', 'environment', 'triage', 'steps'];

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

  // Last resort: truncate the summary itself. Iterative rather than a single
  // subtraction, because percent-encoding can expand one character into three —
  // trimming by the raw overflow would undershoot on a summary full of newlines
  // or non-ASCII. Halving converges in a handful of passes.
  const SUMMARY_FLOOR = 40;
  let guard = 24;
  while (url.length > ISSUE_URL_MAX && guard > 0) {
    const current = working.summary ?? '';
    if (current.length <= SUMMARY_FLOOR) break;
    const next = Math.max(SUMMARY_FLOOR, Math.floor(current.length / 2));
    working.summary = current.slice(0, next);
    url = render(working);
    guard -= 1;
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
export async function fileBugReport(
  input: ReportInput,
  reviewed?: ReportPreview,
): Promise<ReportResult> {
  // Publish exactly what was reviewed. Rebuilding here would attach a bundle
  // the user never saw — including any entries logged while they were reading
  // the preview.
  const preview = reviewed ?? (await buildReportPreview(input));
  const bundle = preview.bundle;
  const opts: BundleOptions = { includeSerialTail: input.includeSerialTail ?? false };
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
