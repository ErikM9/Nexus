'use client';

import React from 'react';

type Fallback = React.ReactNode | ((retry: () => void) => React.ReactNode);

interface Props {
  children: React.ReactNode;
  /* Shown instead of the children after a crash, and when a function it receives a callback that renders the children again */
  fallback?: Fallback;
  /* Values such as the open room's ID whose change clears a caught error, so one crashed view does not block the next */
  resetKeys?: readonly unknown[];
}

interface State {
  hasError: boolean;
}

const keysChanged = (previous: readonly unknown[] = [], next: readonly unknown[] = []): boolean =>
  previous.length !== next.length || previous.some((value, i) => !Object.is(value, next[i]));

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Nexus UI crashed', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    /* The update that records the crash is skipped, so keys changed by the very render that failed cannot re-render the failing children straight away */
    if (this.state.hasError && prevState.hasError && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.retry();
    }
  }

  retry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(this.retry);
    if (fallback) return fallback;

    return (
      <div className="flex items-center justify-center h-full p-4" role="alert">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-destructive mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">An unexpected error occurred.</p>
          <div className="mt-4 flex items-center justify-center gap-4">
            <button
              onClick={this.retry}
              className="text-base font-semibold tracking-wide text-blue-600 hover:underline"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="text-base font-semibold tracking-wide text-blue-600 hover:underline"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/* HOC that wraps a component in its own error boundary */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  fallback?: Fallback
): React.FC<P> {
  const Wrapped: React.FC<P> = (props) => (
    <ErrorBoundary fallback={fallback}>
      <Component {...props} />
    </ErrorBoundary>
  );

  Wrapped.displayName = `withErrorBoundary(${Component.displayName || Component.name || 'Component'})`;
  return Wrapped;
}

export default ErrorBoundary;