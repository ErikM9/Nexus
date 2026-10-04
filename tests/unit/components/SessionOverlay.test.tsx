import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
  })),
}));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
  confirmVerificationRequest: vi.fn(async () => true),
  declineVerificationRequest: vi.fn(async () => true),
  cancelVerificationRequest: vi.fn(async () => true),
  requestVerificationForMyOtherSessions: vi.fn(),
  restoreWithRecoveryKey: vi.fn(async () => ({ imported: 0, total: 0 })),
  RecoveryKeyError: class RecoveryKeyError extends Error {
    constructor(readonly problem: string, message: string) {
      super(message);
    }
  },
  logoutMatrixClient: vi.fn(async () => ({ serverSignedOut: true })),
  createRecoveryKey: vi.fn(async () => ({ recoveryKey: 'EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb', backup: 'created' })),
  BackupReplaceConfirmationError: class BackupReplaceConfirmationError extends Error {},
  RecoveryKeyIncompleteError: class RecoveryKeyIncompleteError extends Error {},
  clearCachedRecoveryKey: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(() => 'toast-id'),
  },
}));

import toast from 'react-hot-toast';
import SessionOverlay from '@/app/app-components/SessionOverlay';
import {
  cancelVerificationRequest,
  confirmVerificationRequest,
  getMatrixClient,
  requestVerificationForMyOtherSessions,
  type VerificationSnapshot,
} from '@/app/utils/matrix';

describe('SessionOverlay Component', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    window.__matrix_ready = true;
    
    mockClient = {
      getUserId: () => '@testuser:matrix.org',
      getDeviceId: () => 'TESTDEVICE',
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      getCrypto: () => ({
        requestOwnUserVerification: vi.fn(async () => ({ transactionId: 'test_txn' })),
      }),
    };

    (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);
    
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders without crashing', () => {
      expect(() => render(<SessionOverlay />)).not.toThrow();
    });

    it('renders nothing initially when no verification requests', () => {
      const { container } = render(<SessionOverlay />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Event Listening', () => {
    it('sets up event listener for verification requests', async () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      render(<SessionOverlay />);

      await waitFor(() => {
        expect(addEventListenerSpy).toHaveBeenCalledWith(
          'matrix-verification-request',
          expect.any(Function)
        );
      });

      addEventListenerSpy.mockRestore();
    });

    it('cleans up event listener on unmount', async () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      
      const { unmount } = render(<SessionOverlay />);
      unmount();

      await waitFor(() => {
        expect(removeEventListenerSpy).toHaveBeenCalledWith(
          'matrix-verification-request',
          expect.any(Function)
        );
      });

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('Component Lifecycle', () => {
    it('unmounts without error', () => {
      const { unmount } = render(<SessionOverlay />);
      expect(() => unmount()).not.toThrow();
    });

    it('handles multiple renders', () => {
      const { rerender } = render(<SessionOverlay />);
      expect(() => rerender(<SessionOverlay />)).not.toThrow();
      expect(() => rerender(<SessionOverlay />)).not.toThrow();
    });
  });

  describe('Matrix Ready State', () => {
    it('listens for matrix-ready event', async () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      render(<SessionOverlay />);

      await waitFor(() => {
        expect(addEventListenerSpy).toHaveBeenCalledWith(
          'matrix-ready',
          expect.any(Function)
        );
      });

      addEventListenerSpy.mockRestore();
    });

    it('listens for matrix-not-ready event', async () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
      
      render(<SessionOverlay />);

      await waitFor(() => {
        expect(addEventListenerSpy).toHaveBeenCalledWith(
          'matrix-not-ready',
          expect.any(Function)
        );
      });

      addEventListenerSpy.mockRestore();
    });
  });

  /* The overlay renders nothing until a nexus-encryption-open event fires, asserted via stable text */
  describe('Mode routing via nexus-encryption-open', () => {
    it('opens the overlay for recovery_create mode', async () => {
      const { container } = render(<SessionOverlay />);
      expect(container.firstChild).toBeNull();

      fireEvent(window, new CustomEvent('nexus-encryption-open', {
        detail: { mode: 'recovery_create' },
      }));

      await waitFor(() => {
        expect(container.firstChild).not.toBeNull();

        expect(screen.queryByText(/recovery key/i)).toBeInTheDocument();
      });
    });

    it('opens the overlay for recovery_restore mode', async () => {
      const { container } = render(<SessionOverlay />);
      expect(container.firstChild).toBeNull();

      fireEvent(window, new CustomEvent('nexus-encryption-open', {
        detail: { mode: 'recovery_restore' },
      }));

      await waitFor(() => {
        expect(container.firstChild).not.toBeNull();

        expect(screen.queryByText('Use Recovery Key')).toBeInTheDocument();
      });
    });

    it('opens the overlay for forget mode and shows a warning', async () => {
      const { container } = render(<SessionOverlay />);
      expect(container.firstChild).toBeNull();

      fireEvent(window, new CustomEvent('nexus-encryption-open', {
        detail: { mode: 'forget' },
      }));

      await waitFor(() => {
        expect(container.firstChild).not.toBeNull();

        expect(screen.queryByText('Forget this session?')).toBeInTheDocument();
      });
    });

    it('closes the overlay when the close action is dispatched', async () => {
      const { container } = render(<SessionOverlay />);

      fireEvent(window, new CustomEvent('nexus-encryption-open', {
        detail: { mode: 'forget' },
      }));

      await waitFor(() => { expect(container.firstChild).not.toBeNull(); });

      /* The Escape listener isn't reached by an outside keyDown in jsdom, so use the Close button */
      fireEvent.click(screen.getByLabelText('Close'));

      await waitFor(() => {
        expect(container.firstChild).toBeNull();
      });
    });
  });

  describe('Verification requests', () => {
    const incoming = (patch: Partial<VerificationSnapshot> = {}): VerificationSnapshot => ({
      id: 'txn-in',
      txnId: 'txn-in',
      fromUserId: '@testuser:matrix.org',
      fromDeviceId: 'PHONEDEVICE',
      createdAt: Date.now(),
      phase: 'requested',
      outgoing: false,
      ...patch,
    });

    const announce = (snap: VerificationSnapshot) =>
      act(() => {
        window.dispatchEvent(new CustomEvent('matrix-verification-request', { detail: snap }));
      });

    const openVerifyPanel = async () => {
      fireEvent(window, new CustomEvent('nexus-encryption-open', { detail: { mode: 'verification' } }));
      await screen.findByRole('button', { name: 'Start Verification' });
    };

    it('keeps a request announced before the client was ready', async () => {
      window.__matrix_ready = false;
      render(<SessionOverlay />);
      announce(incoming());

      act(() => {
        window.__matrix_ready = true;
        window.dispatchEvent(new Event('matrix-ready'));
      });

      expect(await screen.findByText('Verification requested')).toBeInTheDocument();
      expect(screen.getByText('PHONEDEVICE')).toBeInTheDocument();
    });

    it('never lists an outgoing request as an incoming one', () => {
      render(<SessionOverlay />);

      announce(incoming({ id: 'txn-out', outgoing: true }));

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('shows why accepting a request failed', async () => {
      vi.mocked(confirmVerificationRequest).mockRejectedValueOnce(
        new Error('This verification has ended. It was answered on another device.')
      );
      render(<SessionOverlay />);
      announce(incoming());
      fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('This verification has ended. It was answered on another device.')
      );
    });

    it('closes an open request when the other device cancels it and says so', async () => {
      render(<SessionOverlay />);
      announce(incoming());
      fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

      announce(incoming({ phase: 'cancelled', cancelReason: 'The request timed out.' }));

      await waitFor(() => expect(screen.queryByText('Incoming verification request')).not.toBeInTheDocument());
      expect(toast.error).toHaveBeenCalledWith('Verification cancelled. The request timed out.');
    });

    it('withdraws its outgoing request when the Verify panel is closed', async () => {
      vi.mocked(requestVerificationForMyOtherSessions).mockResolvedValueOnce(incoming({ id: 'txn-mine', outgoing: true }));
      render(<SessionOverlay />);
      await openVerifyPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Start Verification' }));
      await screen.findByText('Waiting for the emoji code…');

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      expect(cancelVerificationRequest).toHaveBeenCalledWith('txn-mine');
    });

    it('shows why its outgoing request ended and offers to start again', async () => {
      vi.mocked(requestVerificationForMyOtherSessions).mockResolvedValueOnce(incoming({ id: 'txn-mine', outgoing: true }));
      render(<SessionOverlay />);
      await openVerifyPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Start Verification' }));
      await screen.findByText('Waiting for the emoji code…');

      announce(incoming({ id: 'txn-mine', outgoing: true, phase: 'cancelled', cancelReason: "The emoji didn't match." }));

      expect(await screen.findByRole('alert')).toHaveTextContent("Verification cancelled. The emoji didn't match.");
      expect(screen.getByRole('button', { name: 'Start Verification' })).toBeEnabled();
    });
  });
});