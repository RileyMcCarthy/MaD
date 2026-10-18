// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { setLogFilter, subscribeLog, type LogEntry } from '../diagnostics/log';
import { trackUserActions } from '../diagnostics/actions';
import { NotificationType } from '../domain/types';
import Toast from './Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Toast', () => {
  let root: Root | undefined;
  beforeAll(() => {
    setLogFilter('');
    trackUserActions();
  });
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
  });

  behaviour(
    {
      id: 'ui.toast-click-hides-message',
      covers: 'src/ui/Toast.tsx#Toast',
      given: 'a toast saying a test the user named "Jo secret tensile" was saved, clicked to dismiss it',
      expect: {
        'message-absent': 'the message appears nowhere in the logged click',
        'named-by-test-id': 'the click is named by the toast\u2019s test id',
        'still-described': 'the toast keeps a fixed accessible name and the message as its description',
      },
      why: { 'message-absent': 'toast messages can carry names the user typed, and the report becomes a public issue' },
    },
    () => {
      const message = 'Test "Jo secret tensile" saved';
      const onDismiss = vi.fn();
      const host = document.body.appendChild(document.createElement('div'));
      root = createRoot(host);
      act(() => {
        root!.render(
          createElement(Toast, { n: { id: 7, t: 0, Type: NotificationType.SUCCESS, Message: message }, onDismiss }),
        );
      });

      const toast = host.querySelector<HTMLElement>('[role="button"]')!;
      const clicks: LogEntry[] = [];
      const stop = subscribeLog((e) => {
        if (e.cat === 'ui' && e.tag === 'click') clicks.push(e);
      });
      act(() => toast.click());
      stop();

      expect(clicks).toHaveLength(1);
      expect(JSON.stringify(clicks[0])).not.toContain('secret');
      expect(clicks[0].msg).toBe('toast-dismiss');
      expect(onDismiss).toHaveBeenCalled();
      expect(toast.getAttribute('aria-label')).toBe('Dismiss notification');
      expect(document.getElementById(toast.getAttribute('aria-describedby')!)?.textContent).toBe(message);
    },
  );
});
