// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { clearLog, setLogFilter, subscribeLog, type LogEntry } from './log';
import { trackUserActions } from './actions';

/** Clicks `el` with tracking on, and returns the `ui/click` entries it logged. */
function clicksFrom(el: HTMLElement): LogEntry[] {
  const seen: LogEntry[] = [];
  const stop = subscribeLog((e) => {
    if (e.cat === 'ui' && e.tag === 'click') seen.push(e);
  });
  el.click();
  stop();
  return seen;
}

describe('trackUserActions click names', () => {
  beforeAll(() => {
    setLogFilter('');
    trackUserActions();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    clearLog();
  });

  behaviour(
    {
      id: 'diag.action-click-hides-user-text',
      covers: 'src/diagnostics/actions.ts#controlName',
      given: 'a click on a button in a saved-profiles list whose only label is the name the user gave the profile',
      expect: {
        'name-absent': 'the profile name appears nowhere in the logged entry',
        'role-and-place': 'the click is named by its role, the list it sits in, and the length of its text',
      },
      why: { 'name-absent': 'the report becomes a public issue, and names never enter it' },
    },
    () => {
      document.body.innerHTML =
        '<ul data-testid="profile-list"><li><button>Riley\u2019s secret sample</button></li></ul>';
      const [entry] = clicksFrom(document.querySelector('button')!);
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain('secret');
      expect(entry.msg).toBe('button in profile-list (21 characters)');
    },
  );

  behaviour(
    {
      id: 'diag.action-click-named-by-test-id',
      covers: 'src/diagnostics/actions.ts#controlName',
      given: 'a click on a button with a data-testid, an aria label and visible text',
      expect: { 'test-id-first': 'the click is named by its test id' },
    },
    () => {
      document.body.innerHTML = '<button data-testid="connect-btn" aria-label="Connect to machine">Connect</button>';
      const [entry] = clicksFrom(document.querySelector('button')!);
      expect(entry.msg).toBe('connect-btn');
    },
  );
});
