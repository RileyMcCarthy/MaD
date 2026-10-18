/**
 * What the user did, for the bug report: every button or link they clicked
 * and every field they changed, alongside the route changes the UI already
 * logs. Without it a report says what broke but not how to get there.
 *
 * Privacy: a field's value is kept only when it is a number, a choice from a
 * list, or a checkbox — the machine settings a reproduction needs. Free text
 * (names, descriptions, the GitHub token) is recorded by length only. A
 * clicked control is named by its test id or aria label, never by its visible
 * text, which can be a name the user typed.
 */

import { logger } from './log';

const log = logger('ui');

/** Longest name kept for a clicked control or an edited field. */
const NAME_MAX = 60;

const NUMBER_TEXT = /^-?\d*\.?\d*$/;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX)}…` : flat;
}

/** The parts of an edited field that decide what may be recorded. */
export interface EditedField {
  /** `input` type, or `select` / `textarea`. */
  kind: string;
  value: string;
  checked?: boolean;
  /** The chosen option's text, for a list. */
  optionText?: string;
}

/** What an edit is logged as: the value for numbers, lists and checkboxes; otherwise its length. */
export function recordableEdit(field: EditedField): Record<string, unknown> {
  if (field.kind === 'checkbox' || field.kind === 'radio') return { checked: field.checked === true };
  if (field.kind === 'select') return { value: clip(field.optionText ?? field.value) };
  if (field.kind === 'password' || field.kind === 'file') return { length: field.value.length };
  if (field.kind === 'number' || field.kind === 'range' || NUMBER_TEXT.test(field.value)) {
    return { value: field.value };
  }
  return { length: field.value.length };
}

/**
 * The name a control is logged under: its `data-testid`, then its
 * `aria-label` or `title`. Those are written by developers. Visible text is
 * not: a button in a list of saved profiles or samples, or a file name, shows
 * what the user typed, and the report becomes a public issue. So a control
 * named only by its text is logged by its role, the test id of the nearest
 * container that has one, and the length of the text, never the text itself.
 */
export function controlName(el: Element): string {
  const testId = el.getAttribute('data-testid');
  if (testId) return clip(testId);
  const aria = el.getAttribute('aria-label') ?? el.getAttribute('title');
  if (aria?.trim()) return clip(aria);
  const role = el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase());
  const area = el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid');
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const where = area ? ` in ${clip(area)}` : '';
  return text ? `${role}${where} (${text.length} characters)` : `${role}${where}`;
}

/** The label of a form field: its `label.field` text, aria label, name or placeholder. */
function fieldName(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  const label = el.closest('label');
  if (label) {
    // The label's own text, without the text of the control inside it.
    let text = '';
    label.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) text += n.textContent ?? '';
    });
    if (text.trim()) return clip(text);
  }
  return clip(
    el.getAttribute('aria-label') ??
      el.getAttribute('data-testid') ??
      el.getAttribute('name') ??
      el.getAttribute('placeholder') ??
      el.tagName.toLowerCase(),
  );
}

function onClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  const control = target?.closest('button, a, [role="button"], summary, input[type="checkbox"], input[type="radio"]');
  if (!control || control instanceof HTMLInputElement) return; // checkboxes are logged as edits
  const data: Record<string, unknown> = { control: control.tagName.toLowerCase() };
  const testId = control.getAttribute('data-testid');
  if (testId) data.testId = testId;
  if ((control as HTMLButtonElement).disabled) data.disabled = true;
  log.info('click', controlName(control), data);
}

function onChange(event: Event): void {
  const el = event.target;
  if (
    !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
  ) {
    return;
  }
  const kind = el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'textarea' : el.type;
  const field: EditedField = {
    kind,
    value: el.value,
    checked: el instanceof HTMLInputElement ? el.checked : undefined,
    optionText: el instanceof HTMLSelectElement ? el.selectedOptions[0]?.text : undefined,
  };
  const testId = el.getAttribute('data-testid');
  log.info('edit', fieldName(el), { ...recordableEdit(field), ...(testId ? { testId } : {}) });
}

/**
 * Edits are logged when the field is left (`change`), so typing "12.5" is one
 * entry, not four; clicks are captured before any handler can stop them.
 */
export function trackUserActions(): void {
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
}
