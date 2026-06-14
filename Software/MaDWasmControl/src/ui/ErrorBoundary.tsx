import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Heading for the fallback. */
  title?: string;
  /** When true, render a full-page fallback (last-resort, top-level). Otherwise
   *  a compact in-place panel that keeps the surrounding shell (and the global
   *  STOP button) usable. */
  full?: boolean;
  /** Called with the error so callers can log/report it. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree so one broken screen cannot
 * blank the whole control app — critically, the app shell (which hosts the
 * always-available emergency STOP and the device connection) lives OUTSIDE the
 * screen-level boundary, so it survives a crashed screen.
 *
 * Note: error boundaries do NOT catch errors in event handlers, async code, or
 * the requestAnimationFrame loop — those are handled by the global
 * window 'error' / 'unhandledrejection' listeners installed in App.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
     
    console.error('ErrorBoundary caught:', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.title ?? 'Something went wrong';
    return (
      <div className={this.props.full ? 'gate' : ''} role="alert">
        <div className="panel card" style={{ maxWidth: 560 }}>
          <h1 style={{ marginTop: 0 }}>{title}</h1>
          <p className="muted">
            This part of the app hit an unexpected error. The device connection and the
            emergency STOP control are unaffected.
          </p>
          <pre className="code-block" style={{ maxHeight: 160 }}>
            {error.message}
          </pre>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={this.reset}>
              Try again
            </button>
            {this.props.full && (
              <button onClick={() => window.location.reload()}>Reload app</button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
