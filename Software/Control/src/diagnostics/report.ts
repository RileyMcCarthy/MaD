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
import {
  createIssue,
  getToken,
  hasToken,
  uploadBundleGist,
  type FiledIssue,
} from './github';
import { logger, type LogEntry } from './log';

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

  const steps = bundle.log.entries.filter(
    (e) => e.cat === 'ui' && (e.tag === 'click' || e.tag === 'edit' || e.tag === 'route'),
  ).length;
  const contents = [
    `${bundle.log.entries.length} log entries (${(bundle.triage.sessionMs / 1000).toFixed(0)}s session)`,
    `Your last ${Math.min(steps, 30)} steps (pages, clicks, numbers and choices you set; typed text only as a length)`,
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

/** A message's first line; a component stack or hint after it is in the attached log. */
function firstLine(msg: string | undefined): string {
  return (msg ?? '').split('\n')[0].trim();
}

/** The first stack an entry carries, wherever its call site put it. */
function entryStack(e: LogEntry): string | undefined {
  const d = e.data;
  if (!d) return undefined;
  const nested = (v: unknown): unknown =>
    v !== null && typeof v === 'object' ? (v as { stack?: unknown }).stack : undefined;
  const candidates = [d.stack, nested(d.detail), nested(d.error), d.componentStack];
  const found = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '');
  return found?.trim();
}

/**
 * The last few error-level entries — usually the actual story.
 *
 * With `stackLines` each error is followed by that many frames of its stack.
 * One crash is typically logged three times (the console, the boundary, the
 * crash entry) with the same trace, so a stack already shown is not repeated.
 */
function recentErrors(bundle: DiagnosticsBundle, limit = 5, stackLines = 0): string {
  const errors = bundle.log.entries.filter((e) => e.level === 'error').slice(-limit);
  if (errors.length === 0) return 'None recorded.';
  const shown = new Set<string>();
  return errors
    .map((e) => {
      const at = new Date(e.t).toISOString().slice(11, 23);
      const head = `${at} ${e.cat}/${e.tag} ${firstLine(e.msg)}`.trim();
      const stack = stackLines > 0 ? entryStack(e) : undefined;
      if (stack === undefined || shown.has(stack)) return head;
      shown.add(stack);
      const frames = stack.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      // A JS stack opens with "Name: message", which the head already says.
      if (frames.length > 0 && !frames[0].startsWith('at ')) frames.shift();
      const kept = frames.slice(0, stackLines).map((l) => `    ${l}`);
      if (frames.length > stackLines) kept.push(`    … ${frames.length - stackLines} more frames`);
      return [head, ...kept].join('\n');
    })
    .join('\n');
}

/** One line on the page load before this one, which a crash or reload would otherwise hide. */
function previousSessionLine(bundle: DiagnosticsBundle): string | undefined {
  const prev = bundle.previousSession;
  if (!prev) return undefined;
  const errors = prev.entries.filter((e) => e.level === 'error').length;
  const span = Math.max(0, prev.updatedAt - prev.startedAt) / 1000;
  return [
    `${prev.entries.length} entries over ${span.toFixed(1)}s`,
    `${errors} error${errors === 1 ? '' : 's'}`,
    prev.closed ? 'closed cleanly' : 'ended unexpectedly (crash, reload or closed tab)',
  ].join(' · ');
}

/** What the gist holds, so a reader knows whether opening it will help. */
function diagnosticsContents(bundle: DiagnosticsBundle): string {
  const parts = [`${bundle.log.entries.length} log entries`];
  if (bundle.serialTail) {
    const t = bundle.serialTail;
    parts.push(`${t.chunks.length} serial chunks (${t.totalRxBytes} B in, ${t.totalTxBytes} B out)`);
  }
  if (bundle.previousSession) parts.push(`previous session (${bundle.previousSession.entries.length} entries)`);
  return parts.join(', ');
}

/** One logged UI step in words: where the user went, what they clicked or changed. */
function describeStep(e: DiagnosticsBundle['log']['entries'][number]): string | null {
  if (e.level === 'error') {
    // Short here: the full message is under Recent errors and in the log.
    const msg = firstLine(e.msg);
    return `✗ ${e.cat}/${e.tag} ${msg.length > 160 ? `${msg.slice(0, 160)}…` : msg}`.trim();
  }
  if (e.cat !== 'ui') return null;
  const d = e.data ?? {};
  if (e.tag === 'route') return `open ${e.msg ?? ''}`;
  if (e.tag === 'click') return `click "${e.msg ?? ''}"${d.disabled ? ' (disabled)' : ''}`;
  if (e.tag === 'edit') {
    if ('checked' in d) return `${d.checked ? 'tick' : 'untick'} "${e.msg ?? ''}"`;
    if ('value' in d) return `set "${e.msg ?? ''}" to ${String(d.value)}`;
    return `type in "${e.msg ?? ''}" (${String(d.length ?? 0)} characters, not recorded)`;
  }
  return null;
}

/**
 * The user's last steps — pages opened, buttons clicked, fields changed — with
 * the errors they ran into in between, oldest first. This is the reproduction
 * recipe a report is otherwise missing.
 */
export function recentActions(bundle: DiagnosticsBundle, limit = 30): string {
  const steps: string[] = [];
  let previous = '';
  for (const e of bundle.log.entries) {
    const step = describeStep(e);
    // Development builds render twice, logging each page change twice in a row.
    if (step === null || (step === previous && e.tag === 'route')) continue;
    previous = step;
    const at = new Date(e.t).toISOString().slice(11, 19);
    steps.push(`${at} ${step}`);
  }
  if (steps.length === 0) return 'None recorded.';
  const shown = steps.slice(-limit);
  const skipped = steps.length - shown.length;
  return [...(skipped > 0 ? [`(${skipped} earlier steps in the attached log)`] : []), ...shown].join('\n');
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
    actions: recentActions(bundle),
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
  const droppable = ['errors', 'counters', 'environment', 'actions', 'triage', 'steps'];

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

/**
 * File the report directly, using the user's stored GitHub token.
 *
 * This is the path that removes the step where reports die: instead of asking
 * someone to drag a downloaded file into a form, the full bundle goes up as a
 * secret gist and the issue links it. Everything happens against
 * `api.github.com`, which is CORS-enabled, so there is still no backend.
 *
 * The gist is attempted first. If it fails (no gist scope on the token), the
 * issue is still created with the triage summary — a report without the full
 * log beats no report.
 */
/** Frames shown per error in an API-filed issue body. */
export const ISSUE_STACK_LINES = 8;

/**
 * Issue body for the one-click path.
 *
 * There is no URL budget here (an issue body allows 65 536 characters), so it
 * carries what the prefilled form has to leave in the attachment: error stacks,
 * the failure counters, and what the previous page load looked like. The gist
 * still holds everything.
 */
export function buildApiIssueBody(
  input: ReportInput,
  bundle: DiagnosticsBundle,
  gistUrl: string | undefined,
): string {
  const previous = previousSessionLine(bundle);
  return [
    input.summary,
    '',
    '### Steps to reproduce',
    input.steps?.trim() ? input.steps : '(not provided)',
    '',
    '### Summary',
    '```',
    formatTriage(bundle.triage),
    '```',
    '',
    '### Recent actions',
    '```',
    recentActions(bundle),
    '```',
    '',
    '### Recent errors',
    '```',
    recentErrors(bundle, 5, ISSUE_STACK_LINES),
    '```',
    '',
    '### Failure counters',
    '```',
    summariseCounters(bundle),
    '```',
    '',
    '### Environment',
    '```',
    environmentBlock(bundle),
    '```',
    '',
    ...(previous ? ['### Previous session', previous, ''] : []),
    gistUrl
      ? `### Diagnostics\n[Full session log](${gistUrl}) (secret gist) — ${diagnosticsContents(bundle)}`
      : '### Diagnostics\nThe diagnostics upload failed; the summary above is all that was captured.',
  ].join('\n');
}

export async function fileBugReportViaApi(
  input: ReportInput,
  reviewed?: ReportPreview,
): Promise<FiledIssue> {
  const token = getToken();
  if (token === null) throw new Error('No GitHub token is configured.');

  const preview = reviewed ?? (await buildReportPreview(input));
  const bundle = preview.bundle;
  const fileName = bundleFileName(new Date());

  let gistUrl: string | undefined;
  try {
    gistUrl = await uploadBundleGist(token, fileName, JSON.stringify(bundle, null, 2));
  } catch (err) {
    log.warn('bug-report', 'gist upload failed; filing without the attachment', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  const body = buildApiIssueBody(input, bundle, gistUrl);

  const issue = await createIssue(token, `[app] ${input.summary.slice(0, 80)}`, body);
  return { ...issue, gistUrl };
}

/** Whether the one-click path is available right now. */
export function canFileDirectly(): boolean {
  return hasToken();
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
