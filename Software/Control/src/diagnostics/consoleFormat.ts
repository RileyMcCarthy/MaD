/**
 * Turn a `console.error(...)` / `console.warn(...)` call into one readable line.
 *
 * React and libraries log with printf-style format strings — React's render
 * error is `console.error('%o\n\n%s\n\n%s\n', error, componentStack, hint)` —
 * and the browser substitutes the arguments only when it prints them. Storing
 * the first argument alone left `%o` and `%s` in reports where the message
 * belonged. This does the substitution the console would.
 */

/** Longest message kept; a full stack is kept separately as the entry's detail. */
export const CONSOLE_MESSAGE_MAX = 500;

function show(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/**
 * The console's own rules, as far as text goes: `%s %d %i %f %o %O %j` take
 * the next argument, `%c` takes one and prints nothing (it is CSS), `%%` is a
 * percent sign, and arguments left over are appended after a space.
 */
export function formatConsoleArgs(args: readonly unknown[]): string {
  if (args.length === 0) return '';
  const [first, ...rest] = args;
  let next = 0;
  let text: string;
  if (typeof first === 'string') {
    text = first.replace(/%([sdifoOjc%])/g, (whole, spec: string) => {
      if (spec === '%') return '%';
      if (next >= rest.length) return whole;
      const value = rest[next++];
      if (spec === 'c') return '';
      if (spec === 'd' || spec === 'i') return String(Math.trunc(Number(value)));
      if (spec === 'f') return String(Number(value));
      return show(value);
    });
  } else {
    text = show(first);
  }
  for (const value of rest.slice(next)) text += ` ${show(value)}`;
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > CONSOLE_MESSAGE_MAX
    ? `${trimmed.slice(0, CONSOLE_MESSAGE_MAX)}…`
    : trimmed;
}

/** The argument worth keeping whole (an Error with its stack), else the first extra one. */
export function consoleDetail(args: readonly unknown[]): unknown {
  const rest = args.slice(1);
  return rest.find((a) => a instanceof Error) ?? rest[0];
}
