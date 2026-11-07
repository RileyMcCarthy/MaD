// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import ErrorBoundary from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Thrower(): never {
  throw new Error('useNavigate is not defined');
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('ErrorBoundary', () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  behaviour(
    {
      id: 'ui.crash-screen-report-bug',
      covers: 'src/ui/ErrorBoundary.tsx#ErrorBoundary',
      given: 'the app crashes while showing the Runs screen, and the user asks to report it from the crash screen',
      expect: {
        'summary-prefilled': 'the bug report opens with the crash message as what went wrong',
        'steps-prefilled': 'the reproduction steps start with the screen the crash happened on',
        'button-hidden': 'the button that opened the report goes away while the report is open',
      },
      why: {
        'summary-prefilled': 'the crash is already in the session log, so the report only needs the user to say what they were doing',
      },
    },
    () => {
      // React and the boundary both log the caught error; that is expected here.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      window.location.hash = '#/runs';
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => root?.render(createElement(ErrorBoundary, { full: true, children: createElement(Thrower) })));

      act(() => byTestId('crash-report-bug')?.click());

      const summary = byTestId('report-summary') as HTMLInputElement | null;
      const steps = byTestId('report-steps') as HTMLTextAreaElement | null;
      expect(summary?.value).toBe('Crash: useNavigate is not defined');
      expect(steps?.value.startsWith('Crashed on #/runs.')).toBe(true);
      expect(byTestId('crash-report-bug')).toBeNull();
    },
  );
});
