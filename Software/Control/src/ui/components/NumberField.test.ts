import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { acceptsNumberText, isIncompleteNumber } from './NumberField';

describe('number field typing', () => {
  behaviour(
    {
      id: 'ui.number-field-cleared-is-incomplete',
      covers: 'src/ui/components/NumberField.tsx#isIncompleteNumber',
      given: 'a number box emptied, or holding only a minus sign or a decimal point',
      expect: {
        'not-yet-a-number': 'the text is not read as a number yet, unlike a box holding 0',
      },
      why: { 'not-yet-a-number': 'reading an emptied box as 0 makes every new entry start with a 0' },
    },
    () => {
      for (const text of ['', '-', '.', '-.']) expect(isIncompleteNumber(text)).toBe(true);
      expect(isIncompleteNumber('0')).toBe(false);
    },
  );

  behaviour(
    {
      id: 'ui.number-field-accepts-numbers',
      covers: 'src/ui/components/NumberField.tsx#acceptsNumberText',
      given: 'keystrokes into a decimal number box',
      expect: {
        'numbers-kept': 'negative, whole and decimal numbers, and their partial forms, are accepted',
        'letters-refused': 'letters, a second decimal point and a minus sign after the digits are refused',
      },
    },
    () => {
      for (const text of ['12', '-3', '1.', '.5', '-0.25', '', '-']) expect(acceptsNumberText(text, false)).toBe(true);
      for (const text of ['1a', '1.2.3', '3-', 'e5']) expect(acceptsNumberText(text, false)).toBe(false);
    },
  );

  behaviour(
    {
      id: 'ui.number-field-whole-numbers',
      covers: 'src/ui/components/NumberField.tsx#acceptsNumberText',
      given: 'keystrokes into a whole-number box, such as a set’s execution count',
      expect: { 'no-decimal-point': 'a decimal point is refused and whole numbers are accepted' },
    },
    () => {
      expect(acceptsNumberText('12', true)).toBe(true);
      expect(acceptsNumberText('1.', true)).toBe(false);
    },
  );
});
