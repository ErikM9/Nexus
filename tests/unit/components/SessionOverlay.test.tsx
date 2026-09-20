import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
  refreshVerificationRequest: vi.fn(() => null),
  requestVerificationForMyOtherSessions: vi.fn(async () => ({ id: 'test_req' })),
  isOutgoingVerificationRequest: vi.fn(() => false),
  restoreEncryptedHistoryFromBackup: vi.fn(async () => {}),
  setRecoveryKey: vi.fn(),
  validateRecoveryKey: vi.fn(async () => true),
  hasCachedRecoveryKey: vi.fn(() => false),
  logoutMatrixClient: vi.fn(async () => {}),
  resetMatrixCryptoStores: vi.fn(async () => {}),
  createRecoveryKey: vi.fn(async () => 'EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb'),
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

import SessionOverlay from '@/app/app-components/SessionOverlay';
import {
  getMatrixClient,
  hasCachedRecoveryKey
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
    (hasCachedRecoveryKey as ReturnType<typeof vi.fn>).mockReturnValue(false);
    
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
});