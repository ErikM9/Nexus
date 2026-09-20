import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary, withErrorBoundary } from '@/app/app-components/ErrorBoundary';

const originalConsoleError = console.error;

/* Suppress console.error since these tests intentionally throw */
beforeEach(() => {
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
});

const ThrowingComponent: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow = true }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>No error</div>;
};

describe('ErrorBoundary', () => {
  describe('normal rendering', () => {
    it('renders children when no error', () => {
      render(
        <ErrorBoundary>
          <div>Child content</div>
        </ErrorBoundary>
      );

      expect(screen.queryByText('Child content')).toBeInTheDocument();
    });

    it('renders multiple children', () => {
      render(
        <ErrorBoundary>
          <div>First child</div>
          <div>Second child</div>
        </ErrorBoundary>
      );

      expect(screen.queryByText('First child')).toBeInTheDocument();
      expect(screen.queryByText('Second child')).toBeInTheDocument();
    });

    it('renders nested components', () => {
      const NestedComponent = () => (
        <div>
          <span>Nested content</span>
        </div>
      );

      render(
        <ErrorBoundary>
          <NestedComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Nested content')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('catches errors and displays fallback UI', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Something went wrong')).toBeInTheDocument();
      expect(screen.queryByText('Test error message')).toBeInTheDocument();
    });

    it('shows reload button in fallback UI', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByRole('button', { name: /reload page/i })).toBeInTheDocument();
    });

    it('has alert role for accessibility', () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByRole('alert')).toBeInTheDocument();
    });

    it('handles error without message', () => {
      const NoMessageError: React.FC = () => {
        throw new Error();
      };

      render(
        <ErrorBoundary>
          <NoMessageError />
        </ErrorBoundary>
      );

      expect(screen.queryByText('An unexpected error occurred')).toBeInTheDocument();
    });
  });

  describe('custom fallback', () => {
    it('renders custom fallback when provided', () => {
      const customFallback = <div>Custom error UI</div>;

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Custom error UI')).toBeInTheDocument();
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });

    it('renders custom fallback component', () => {
      const CustomFallback = () => (
        <div>
          <h1>Oops!</h1>
          <p>Something broke</p>
        </div>
      );

      render(
        <ErrorBoundary fallback={<CustomFallback />}>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Oops!')).toBeInTheDocument();
      expect(screen.queryByText('Something broke')).toBeInTheDocument();
    });
  });

  describe('reload functionality', () => {
    it('calls window.location.reload on button click', () => {
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
      });

      render(
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: /reload page/i }));

      expect(reloadMock).toHaveBeenCalled();
    });
  });

  describe('recovery behavior', () => {
    it('renders children when error condition is fixed on re-render', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <ThrowingComponent shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Something went wrong')).toBeInTheDocument();

      /* An error boundary keeps its error state across a re-render with the same key */
      rerender(
        <ErrorBoundary>
          <ThrowingComponent shouldThrow={false} />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Something went wrong')).toBeInTheDocument();
    });

    it('recovers when key is changed', () => {
      const { rerender } = render(
        <ErrorBoundary key="error-state">
          <ThrowingComponent shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Something went wrong')).toBeInTheDocument();

      /* Changing the key remounts the boundary with a clean error state */
      rerender(
        <ErrorBoundary key="recovered-state">
          <ThrowingComponent shouldThrow={false} />
        </ErrorBoundary>
      );

      expect(screen.queryByText('No error')).toBeInTheDocument();
    });
  });

  describe('nested ErrorBoundaries', () => {
    it('inner boundary catches error first', () => {
      render(
        <ErrorBoundary fallback={<div>Outer fallback</div>}>
          <div>Outer content</div>
          <ErrorBoundary fallback={<div>Inner fallback</div>}>
            <ThrowingComponent />
          </ErrorBoundary>
        </ErrorBoundary>
      );

      expect(screen.queryByText('Outer content')).toBeInTheDocument();
      expect(screen.queryByText('Inner fallback')).toBeInTheDocument();
      expect(screen.queryByText('Outer fallback')).not.toBeInTheDocument();
    });

    it('outer boundary catches error when inner is not present', () => {
      render(
        <ErrorBoundary fallback={<div>Outer fallback</div>}>
          <div>Content before</div>
          <ThrowingComponent />
          <div>Content after</div>
        </ErrorBoundary>
      );

      expect(screen.queryByText('Outer fallback')).toBeInTheDocument();
      expect(screen.queryByText('Content before')).not.toBeInTheDocument();
    });
  });
});

describe('withErrorBoundary HOC', () => {
  it('wraps component with ErrorBoundary', () => {
    const SimpleComponent = () => <div>Simple content</div>;
    const WrappedComponent = withErrorBoundary(SimpleComponent);

    render(<WrappedComponent />);

    expect(screen.queryByText('Simple content')).toBeInTheDocument();
  });

  it('catches errors in wrapped component', () => {
    const BrokenComponent = () => {
      throw new Error('HOC test error');
    };
    const WrappedComponent = withErrorBoundary(BrokenComponent);

    render(<WrappedComponent />);

    expect(screen.queryByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('HOC test error')).toBeInTheDocument();
  });

  it('uses custom fallback when provided', () => {
    const BrokenComponent = () => {
      throw new Error('Test error');
    };
    const customFallback = <div>Custom HOC fallback</div>;
    const WrappedComponent = withErrorBoundary(BrokenComponent, customFallback);

    render(<WrappedComponent />);

    expect(screen.queryByText('Custom HOC fallback')).toBeInTheDocument();
  });

  it('passes props to wrapped component', () => {
    interface Props {
      message: string;
    }
    const PropsComponent: React.FC<Props> = ({ message }) => <div>{message}</div>;
    const WrappedComponent = withErrorBoundary(PropsComponent);

    render(<WrappedComponent message="Hello from props" />);

    expect(screen.queryByText('Hello from props')).toBeInTheDocument();
  });

  it('sets correct displayName', () => {
    const NamedComponent = () => <div>Named</div>;
    NamedComponent.displayName = 'MyComponent';

    const WrappedComponent = withErrorBoundary(NamedComponent);

    expect(WrappedComponent.displayName).toBe('withErrorBoundary(MyComponent)');
  });

  it('uses component name when displayName is not set', () => {
    function RegularComponent() {
      return <div>Regular</div>;
    }

    const WrappedComponent = withErrorBoundary(RegularComponent);

    expect(WrappedComponent.displayName).toBe('withErrorBoundary(RegularComponent)');
  });

  it('handles anonymous components', () => {
    const WrappedComponent = withErrorBoundary(() => <div>Anonymous</div>);

    expect(WrappedComponent.displayName).toBe('withErrorBoundary(Component)');
  });
});