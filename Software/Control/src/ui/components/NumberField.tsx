import { useEffect, useState } from 'react';

/** Text a user can be part-way through typing, which is not yet a number. */
export function isIncompleteNumber(text: string): boolean {
  return text === '' || text === '-' || text === '.' || text === '-.';
}

/** Whether a keystroke leaves text that is, or can still become, a number. */
export function acceptsNumberText(text: string, integer: boolean): boolean {
  return integer ? /^-?\d*$/.test(text) : /^-?\d*\.?\d*$/.test(text);
}

/**
 * The number a box settles to when it loses focus: an unfinished entry falls
 * back to `min` (or 0), and anything below `min` is raised to it.
 */
export function settleNumberText(draft: string, min?: number): number {
  const n = isIncompleteNumber(draft) ? (min ?? 0) : Number(draft);
  return min !== undefined && n < min ? min : n;
}

/**
 * Numeric input that lets the user clear it and type a new number.
 *
 * A controlled `<input type="number" value={n}>` fed through `Number(...)`
 * turns an emptied box into 0 on the spot, so the old value can never be fully
 * deleted and every new entry comes out prefixed by "0"; it also refuses a
 * leading minus sign. This keeps the text as typed and passes the number on
 * once the text is a complete number. Left empty, the field falls back to
 * `min` (or 0) when it loses focus.
 */
export default function NumberField({
  label,
  value,
  onChange,
  disabled,
  min,
  integer = false,
  testId,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  /** Lowest value accepted; anything below is raised to it when the field loses focus. */
  min?: number;
  /** Whole numbers only. */
  integer?: boolean;
  testId?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  // Follow a new value from outside (loading a profile, a device read) unless
  // the draft already says the same number the user is typing.
  useEffect(() => {
    if (Number(draft) !== value) setDraft(Number.isFinite(value) ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className="field">
      {label}
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={draft}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          const raw = e.target.value;
          if (!acceptsNumberText(raw, integer)) return;
          setDraft(raw);
          if (!isIncompleteNumber(raw)) {
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(n);
          }
        }}
        onBlur={() => {
          const settled = settleNumberText(draft, min);
          if (settled !== value) onChange(settled);
          setDraft(String(settled));
        }}
      />
    </label>
  );
}
