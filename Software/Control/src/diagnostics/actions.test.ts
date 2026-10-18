import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { recordableEdit } from './actions';

describe('recordableEdit', () => {
  behaviour(
    {
      id: 'diag.action-edit-keeps-settings',
      covers: 'src/diagnostics/actions.ts#recordableEdit',
      given: 'a number typed into a field, an option picked from a list, and a checkbox ticked',
      expect: {
        'number-kept': 'the number is recorded',
        'choice-kept': 'the chosen option is recorded by its text',
        'tick-kept': 'the checkbox is recorded as ticked',
      },
      why: { 'number-kept': 'the settings a user changed are what a reproduction needs' },
    },
    () => {
      expect(recordableEdit({ kind: 'text', value: '-12.5' })).toEqual({ value: '-12.5' });
      expect(recordableEdit({ kind: 'select', value: '2', optionText: '2,000,000' })).toEqual({ value: '2,000,000' });
      expect(recordableEdit({ kind: 'checkbox', value: 'on', checked: true })).toEqual({ checked: true });
    },
  );

  behaviour(
    {
      id: 'diag.action-edit-hides-text',
      covers: 'src/diagnostics/actions.ts#recordableEdit',
      given: 'free text, a password field and a pasted GitHub token',
      expect: { 'length-only': 'only the number of characters is recorded, never the text' },
      why: { 'length-only': 'the report becomes a public issue' },
    },
    () => {
      expect(recordableEdit({ kind: 'text', value: 'Steel dogbone A' })).toEqual({ length: 15 });
      expect(recordableEdit({ kind: 'password', value: '123' })).toEqual({ length: 3 });
      expect(recordableEdit({ kind: 'text', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).toEqual({ length: 40 });
    },
  );

  behaviour(
    {
      id: 'diag.action-edit-kind-rules',
      covers: 'src/diagnostics/actions.ts#recordableEdit',
      given: 'a number field, a slider, a radio button, a chosen file and a list without option text',
      expect: {
        'number-kind-kept': 'a number field or slider keeps its value, even when it does not look like plain digits',
        'radio-kept': 'a radio button is recorded as picked or not',
        'file-length-only': 'a chosen file is recorded by the length of its name only',
        'list-value-fallback': 'a list choice without option text is recorded by its value',
      },
      why: { 'file-length-only': 'a file name is something the user wrote' },
    },
    () => {
      expect(recordableEdit({ kind: 'number', value: '1e3' })).toEqual({ value: '1e3' });
      expect(recordableEdit({ kind: 'range', value: '75' })).toEqual({ value: '75' });
      expect(recordableEdit({ kind: 'radio', value: 'metric', checked: true })).toEqual({ checked: true });
      expect(recordableEdit({ kind: 'radio', value: 'metric' })).toEqual({ checked: false });
      expect(recordableEdit({ kind: 'file', value: 'C:\\fakepath\\run 12.csv' })).toEqual({ length: 22 });
      expect(recordableEdit({ kind: 'select', value: '115200' })).toEqual({ value: '115200' });
    },
  );
});
