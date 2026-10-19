import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { acceptsNumberText, isIncompleteNumber, settleNumberText, typedNumber } from './NumberField';

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

  behaviour(
    {
      id: 'ui.number-field-settles-on-blur',
      covers: 'src/ui/components/NumberField.tsx#settleNumberText',
      given: 'a number box losing focus, with or without a minimum set',
      expect: {
        'unfinished-falls-back': 'an empty box or a lone minus sign settles to the minimum, or to 0 when the box has none',
        'raised-to-minimum': 'a number below the minimum is raised to the minimum',
        'complete-kept': 'a complete number at or above the minimum is kept as typed',
      },
      why: { 'raised-to-minimum': 'a set must run at least once, so its execution count has a minimum of 1' },
    },
    () => {
      expect(settleNumberText('')).toBe(0);
      expect(settleNumberText('', 1)).toBe(1);
      expect(settleNumberText('-')).toBe(0);
      expect(settleNumberText('-', 1)).toBe(1);
      expect(settleNumberText('0', 1)).toBe(1);
      expect(settleNumberText('-4', 1)).toBe(1);
      expect(settleNumberText('12.5')).toBe(12.5);
      expect(settleNumberText('-3')).toBe(-3);
      expect(settleNumberText('3', 1)).toBe(3);
    },
  );

  behaviour(
    {
      id: 'ui.number-field-holds-below-minimum',
      covers: 'src/ui/components/NumberField.tsx#typedNumber',
      given: 'a number box with a minimum of 1, such as a set’s execution count, while a value is being typed',
      expect: {
        'below-held': 'a minus sign, 0 or a negative number is not passed on as the count until the box settles',
        'valid-passed': 'a number at or above the minimum is passed on as soon as it is typed',
      },
      why: { 'below-held': 'anything that reads the set before the box loses focus, such as the G-code preview, would see an impossible execution count' },
    },
    () => {
      for (const text of ['-', '0', '-2', '']) expect(typedNumber(text, 1)).toBeUndefined();
      expect(typedNumber('1', 1)).toBe(1);
      expect(typedNumber('12', 1)).toBe(12);
    },
  );

  behaviour(
    {
      id: 'ui.number-field-no-minimum-passes-negatives',
      covers: 'src/ui/components/NumberField.tsx#typedNumber',
      given: 'a number box with no minimum, such as a jog distance, while a value is being typed',
      expect: { 'negatives-passed': 'zero, negative and decimal numbers are passed on as soon as they are typed' },
    },
    () => {
      expect(typedNumber('0')).toBe(0);
      expect(typedNumber('-2.5')).toBe(-2.5);
      expect(typedNumber('-')).toBeUndefined();
    },
  );
});
