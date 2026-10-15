import { describe, it, expect, vi, beforeEach, onTestFinished, type MockInstance } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '@/app/app-components/ErrorBoundary';

const CRASH = 'Timeline exploded';

const View = ({ broken = false }: { broken?: boolean }) => {
  if (broken) throw new Error(CRASH);
  return <p>Messages</p>;
};

describe('ErrorBoundary', () => {
  let consoleError: MockInstance<typeof console.error>;

  /* The boundary's own log lines, leaving out what React and jsdom print about the same error */
  const crashLogs = () => consoleError.mock.calls.filter(([label]) => label === 'Nexus UI crashed');

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows its children while nothing fails', () => {
    render(
      <ErrorBoundary fallback={<p>Chat failed to load.</p>}>
        <View />
      </ErrorBoundary>
    );

    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.queryByText('Chat failed to load.')).not.toBeInTheDocument();
  });

  describe('after a child crashes', () => {
    it('replaces the children with a general alert that keeps the error text to itself', () => {
      render(
        <ErrorBoundary>
          <View broken />
        </ErrorBoundary>
      );

      const alert = screen.getByRole('alert');
      expect(within(alert).getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
      expect(alert).toHaveTextContent('An unexpected error occurred.');
      expect(alert).not.toHaveTextContent(CRASH);
    });

    it('logs the crash once, with the error and the stack of components that led to it', () => {
      render(
        <ErrorBoundary>
          <View broken />
        </ErrorBoundary>
      );

      expect(crashLogs()).toEqual([
        ['Nexus UI crashed', expect.objectContaining({ message: CRASH }), expect.stringMatching(/\bat View\b/)],
      ]);
    });

    it('renders the children again when Try again is pressed', async () => {
      const { rerender } = render(
        <ErrorBoundary>
          <View broken />
        </ErrorBoundary>
      );
      rerender(
        <ErrorBoundary>
          <View />
        </ErrorBoundary>
      );

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(screen.getByText('Messages')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('reloads the page when Reload page is pressed', async () => {
      /* The Location object of jsdom refuses spies, so the window gets a copy of it whose reload can be watched */
      const location = Object.getOwnPropertyDescriptor(window, 'location')!;
      onTestFinished(() => {
        Object.defineProperty(window, 'location', location);
      });
      const reload = vi.fn();
      Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
      render(
        <ErrorBoundary>
          <View broken />
        </ErrorBoundary>
      );

      await userEvent.click(screen.getByRole('button', { name: 'Reload page' }));

      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('with a fallback of its own', () => {
    it('shows a fallback element in place of the general alert', () => {
      render(
        <ErrorBoundary fallback={<p>Chat failed to load.</p>}>
          <View broken />
        </ErrorBoundary>
      );

      expect(screen.getByText('Chat failed to load.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('hands a fallback function the callback that renders the children again', async () => {
      const fallback = (retry: () => void) => <button onClick={retry}>Retry chat</button>;
      const { rerender } = render(
        <ErrorBoundary fallback={fallback}>
          <View broken />
        </ErrorBoundary>
      );
      rerender(
        <ErrorBoundary fallback={fallback}>
          <View />
        </ErrorBoundary>
      );

      await userEvent.click(screen.getByRole('button', { name: 'Retry chat' }));

      expect(screen.getByText('Messages')).toBeInTheDocument();
    });
  });

  describe('with reset keys', () => {
    it.each([
      ['a key changes', ['!first:hs.test'], ['!second:hs.test']],
      ['a key is added', ['!first:hs.test'], ['!first:hs.test', '$thread']],
    ])('clears a caught error when %s', (_change, before, after) => {
      const { rerender } = render(
        <ErrorBoundary resetKeys={before}>
          <View broken />
        </ErrorBoundary>
      );

      rerender(
        <ErrorBoundary resetKeys={after}>
          <View />
        </ErrorBoundary>
      );

      expect(screen.getByText('Messages')).toBeInTheDocument();
    });

    it('keeps the fallback through a re-render with the same keys', () => {
      const { rerender } = render(
        <ErrorBoundary resetKeys={['!first:hs.test']}>
          <View broken />
        </ErrorBoundary>
      );

      rerender(
        <ErrorBoundary resetKeys={['!first:hs.test']}>
          <View />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('Messages')).not.toBeInTheDocument();
    });

    it('does not retry a crash straight away when the crashing update is the one that changed the keys', () => {
      const { rerender } = render(
        <ErrorBoundary resetKeys={['!first:hs.test']}>
          <View />
        </ErrorBoundary>
      );

      rerender(
        <ErrorBoundary resetKeys={['!second:hs.test']}>
          <View broken />
        </ErrorBoundary>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(crashLogs()).toHaveLength(1);
    });
  });
});