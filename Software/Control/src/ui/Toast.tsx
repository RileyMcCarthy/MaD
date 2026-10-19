import { useEffect } from 'react';
import { NotificationType } from '../domain/types';
import type { UiNotification } from '../store/useStore';

/**
 * Auto-dismissing toast. Errors/warnings linger longer so they stay readable;
 * clicking dismisses immediately.
 *
 * Its accessible name is fixed and the message is its description: clicks are
 * recorded for bug reports under a control's test id or aria label, and a
 * message can carry what the user typed (a test or profile name), so the
 * message must not be part of either.
 */
export default function Toast({ n, onDismiss }: { n: UiNotification; onDismiss: () => void }) {
  useEffect(() => {
    const ms = n.Type === NotificationType.ERROR || n.Type === NotificationType.WARN ? 8000 : 4000;
    const t = setTimeout(onDismiss, ms);
    return () => clearTimeout(t);
  }, [n.id, n.Type, onDismiss]);
  const messageId = `toast-message-${n.id}`;
  return (
    <div
      className={`toast ${n.Type}`}
      onClick={onDismiss}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDismiss();
        }
      }}
      role="button"
      tabIndex={0}
      data-testid="toast-dismiss"
      aria-label="Dismiss notification"
      aria-describedby={messageId}
    >
      <span id={messageId}>{n.Message}</span>
    </div>
  );
}
