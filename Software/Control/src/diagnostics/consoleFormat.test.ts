import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { CONSOLE_MESSAGE_MAX, consoleDetail, formatConsoleArgs } from './consoleFormat';

describe('formatConsoleArgs', () => {
  behaviour(
    {
      id: 'diag.console-format-fills-placeholders',
      covers: 'src/diagnostics/consoleFormat.ts#formatConsoleArgs',
      given: "React's render-error console call: a format string of %o and two %s, then an error, a component stack and a hint",
      expect: {
        'no-placeholders': 'the logged message carries no %o or %s',
        'error-named': 'the message opens with the error name and text',
      },
    },
    () => {
      const msg = formatConsoleArgs([
        '%o\n\n%s\n\n%s\n',
        new ReferenceError('NumberField is not defined'),
        'The above error occurred in the <Create> component.',
        'React will try to recreate this component tree.',
      ]);
      expect(msg).not.toMatch(/%[os]/);
      expect(msg.startsWith('ReferenceError: NumberField is not defined')).toBe(true);
    },
  );

  behaviour(
    {
      id: 'diag.console-format-console-rules',
      covers: 'src/diagnostics/consoleFormat.ts#formatConsoleArgs',
      given: 'console calls using a number, a style, a literal percent sign and arguments beyond the format string',
      expect: {
        'number-filled': 'a %d takes the whole part of its number',
        'style-dropped': 'a %c style string is left out of the text',
        'percent-kept': '%% prints as a single percent sign',
        'extras-appended': 'arguments with no placeholder are appended after a space',
      },
    },
    () => {
      expect(formatConsoleArgs(['%d items', 3.7])).toBe('3 items');
      expect(formatConsoleArgs(['%cwarn', 'color: red'])).toBe('warn');
      expect(formatConsoleArgs(['100%% done'])).toBe('100% done');
      expect(formatConsoleArgs(['saved', { id: 1 }])).toBe('saved {"id":1}');
    },
  );

  behaviour(
    {
      id: 'diag.console-format-bounded',
      covers: 'src/diagnostics/consoleFormat.ts#formatConsoleArgs',
      given: 'a console message far longer than a log line should hold',
      expect: { 'cut-with-marker': 'the message is cut to the line limit and ends with an ellipsis' },
    },
    () => {
      const msg = formatConsoleArgs(['x'.repeat(CONSOLE_MESSAGE_MAX * 2)]);
      expect(msg.length).toBe(CONSOLE_MESSAGE_MAX + 1);
      expect(msg.endsWith('…')).toBe(true);
    },
  );
});

describe('consoleDetail', () => {
  behaviour(
    {
      id: 'diag.console-detail-keeps-error',
      covers: 'src/diagnostics/consoleFormat.ts#consoleDetail',
      given: 'a console call whose error is not its first extra argument',
      expect: { 'error-kept': 'the error, with its stack, is what the log keeps as detail' },
    },
    () => {
      const err = new Error('boom');
      expect(consoleDetail(['%s %o', 'context', err])).toBe(err);
    },
  );
});
