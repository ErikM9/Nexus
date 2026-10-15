import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import { encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api';
import { ME } from '../support/matrixRoom';

vi.mock('@/app/utils/matrix', async () => {
  const recovery = await vi.importActual<typeof import('@/app/utils/matrix/recovery')>('@/app/utils/matrix/recovery');
  return {
    confirmVerificationRequest: vi.fn(async (_id: string) => true),
    declineVerificationRequest: vi.fn(async (_id: string) => true),
    cancelVerificationRequest: vi.fn(async (_id: string) => true),
    requestVerificationForMyOtherSessions: vi.fn(),
    restoreWithRecoveryKey: vi.fn(),
    createRecoveryKey: vi.fn(),
    logoutMatrixClient: vi.fn(),
    RecoveryKeyError: recovery.RecoveryKeyError,
    BackupReplaceConfirmationError: recovery.BackupReplaceConfirmationError,
    RecoveryKeyIncompleteError: recovery.RecoveryKeyIncompleteError,
  };
});

import SessionOverlay from '@/app/app-components/SessionOverlay';
import {
  BackupReplaceConfirmationError,
  RecoveryKeyError,
  RecoveryKeyIncompleteError,
  cancelVerificationRequest,
  confirmVerificationRequest,
  createRecoveryKey,
  declineVerificationRequest,
  logoutMatrixClient,
  requestVerificationForMyOtherSessions,
  restoreWithRecoveryKey,
  type VerificationSnapshot,
} from '@/app/utils/matrix';

const OTHER_DEVICE = 'PHONEDEVICE';
const DAY = 24 * 60 * 60 * 1000;

/* Recovery keys the way the SDK encodes them, here for 32 bytes of 7 and 32 bytes of 8 */
const KEY = encodeRecoveryKey(new Uint8Array(32).fill(7))!;
const NEW_KEY = encodeRecoveryKey(new Uint8Array(32).fill(8))!;

/* One emoji comparison as the verification module lists it, seven emoji and three numbers */
const SAS = { sasEmojis: ['🐶', '🔑', '🌵', '🎸', '🚀', '🍄', '⚓'], sasDecimals: [4127, 6250, 1876] };

/* Each panel by the header menu item that asks for it, with the mode the item sends and the title the panel shows */
const PANELS = [
  ['Get Recovery Key', 'recovery_create', 'Get Recovery Key'],
  ['Use Recovery Key', 'recovery_restore', 'Use Recovery Key'],
  ['Verify this session', 'verification', 'Verification'],
  ['Forget this session', 'forget', 'Forget this session?'],
] as const;

/* A request from another of my devices, shaped like the snapshots the verification module publishes */
const incoming = (patch: Partial<VerificationSnapshot> = {}): VerificationSnapshot => ({
  id: 'txn-in',
  txnId: 'txn-in',
  fromUserId: ME,
  fromDeviceId: OTHER_DEVICE,
  createdAt: Date.now(),
  phase: 'requested',
  outgoing: false,
  ...patch,
});

/* The request this session sends to my other devices, before one of them answers */
const mine = (patch: Partial<VerificationSnapshot> = {}): VerificationSnapshot => ({
  id: 'txn-mine',
  txnId: 'txn-mine',
  fromUserId: ME,
  createdAt: Date.now(),
  phase: 'requested',
  outgoing: true,
  ...patch,
});

/* Publishes a snapshot the way the verification module does on every change of a request */
const publish = (snap: VerificationSnapshot) =>
  window.dispatchEvent(new CustomEvent('matrix-verification-request', { detail: snap }));

const announce = (snap: VerificationSnapshot) =>
  act(() => {
    publish(snap);
  });

/* Asks for a panel the way the header's menus do */
const openPanel = (mode: string) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('nexus-encryption-open', { detail: { mode } }));
  });

const clientStops = () =>
  act(() => {
    window.__matrix_ready = false;
    window.dispatchEvent(new Event('matrix-not-ready'));
  });

const clientBecomesReady = () =>
  act(() => {
    window.__matrix_ready = true;
    window.dispatchEvent(new Event('matrix-ready'));
  });

/* The backdrop has no role or label of its own, so it is found as the sibling the open dialog sits on */
const backdrop = () => screen.getByRole('button', { name: 'Close' }).parentElement!.previousElementSibling!;

const CLOSING = [
  ['Close', () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
  ['a press on the backdrop', () => userEvent.click(backdrop())],
] as const;

/* Records every event of one type that reaches the window until the test ends */
const eventsOnWindow = (type: string) => {
  const events: Event[] = [];
  const record = (event: Event) => events.push(event);
  window.addEventListener(type, record);
  onTestFinished(() => window.removeEventListener(type, record));
  return events;
};

const shownKey = () => screen.queryByRole('status', { name: 'Your Recovery Key' });

describe('SessionOverlay', () => {
  beforeEach(() => {
    window.__matrix_ready = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('opening a panel', () => {
    it('forgets a panel asked for before the client was ready', () => {
      window.__matrix_ready = false;
      render(<SessionOverlay />);
      openPanel('forget');

      clientBecomesReady();

      expect(screen.queryByText('Forget this session?')).not.toBeInTheDocument();
    });
  });

  describe('an incoming verification request', () => {
    const openRequest = async (snap = incoming()) => {
      render(<SessionOverlay />);
      announce(snap);
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    };

    it('holds back a request announced before the client is ready', () => {
      window.__matrix_ready = false;
      render(<SessionOverlay />);

      announce(incoming());

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('keeps a request announced before the client was ready', () => {
      window.__matrix_ready = false;
      render(<SessionOverlay />);
      announce(incoming());

      clientBecomesReady();

      expect(screen.getByText('Verification requested')).toBeInTheDocument();
      expect(screen.getByText(/^From/)).toHaveTextContent(`From ${ME} · device ${OTHER_DEVICE} ·`);
    });

    it('puts a newer request in front of the one it shows', () => {
      render(<SessionOverlay />);
      announce(incoming({ id: 'txn-old', fromDeviceId: 'LAPTOPDEVICE', createdAt: Date.now() - 60_000 }));

      announce(incoming());

      expect(screen.getByText(/^From/)).toHaveTextContent(`device ${OTHER_DEVICE}`);
    });

    it('opens a request in place of its toast', async () => {
      render(<SessionOverlay />);
      announce(incoming());

      await userEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(screen.getByText('Incoming verification request')).toBeInTheDocument();
      expect(screen.getByText('Accept this request?')).toBeInTheDocument();
      expect(screen.getByText(/^Device/)).toHaveTextContent(`Device ${OTHER_DEVICE}`);
      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it.each(CLOSING)('goes back to the toast when the request is closed with %s', async (_way, close) => {
      await openRequest();

      await close();

      expect(screen.queryByText('Incoming verification request')).not.toBeInTheDocument();
      expect(screen.getByText('Verification requested')).toBeInTheDocument();
      expect(declineVerificationRequest).not.toHaveBeenCalled();
    });

    it('accepts a request and stays open for the emoji comparison', async () => {
      await openRequest();

      await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(confirmVerificationRequest).toHaveBeenCalledWith('txn-in');
      expect(screen.getByText('Incoming verification request')).toBeInTheDocument();
    });

    it('disables both answers while one is on its way', async () => {
      vi.mocked(confirmVerificationRequest).mockReturnValue(new Promise(() => {}));
      await openRequest();

      await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    });

    it('shows the emoji and the numbers to compare once both devices are ready', async () => {
      await openRequest();

      announce(incoming({ phase: 'showing_sas', ...SAS }));

      const comparison = screen.getByText('Do the emojis match?').parentElement!;
      expect(screen.getByText('Verify this session')).toBeInTheDocument();
      expect(comparison).toHaveTextContent(SAS.sasEmojis.join(''));
      expect(comparison).toHaveTextContent('Code: 4127 - 6250 - 1876');
    });

    it('confirms matching emoji with Yes and closes the request for good', async () => {
      await openRequest(incoming({ phase: 'showing_sas', ...SAS }));

      await userEvent.click(screen.getByRole('button', { name: 'Yes' }));

      expect(confirmVerificationRequest).toHaveBeenCalledWith('txn-in');
      expect(screen.queryByText('Verify this session')).not.toBeInTheDocument();
      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it.each([
      ['Decline', 'Incoming verification request', incoming()],
      ['No', 'Verify this session', incoming({ phase: 'showing_sas', ...SAS })],
    ])('turns the request down with %s and closes it for good', async (answer, title, snap) => {
      await openRequest(snap);

      await userEvent.click(screen.getByRole('button', { name: answer }));

      expect(declineVerificationRequest).toHaveBeenCalledWith('txn-in');
      expect(screen.queryByText(title)).not.toBeInTheDocument();
      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('says why accepting failed and lets the user try again', async () => {
      const failure = "The request couldn't be accepted. Check your connection and try again.";
      vi.mocked(confirmVerificationRequest).mockRejectedValue(new Error(failure));
      await openRequest();

      await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(toast.error).toHaveBeenCalledWith(failure);
      expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    });

    it('says why declining failed', async () => {
      const failure = 'This verification request is no longer available.';
      vi.mocked(declineVerificationRequest).mockRejectedValue(new Error(failure));
      await openRequest();

      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

      expect(toast.error).toHaveBeenCalledWith(failure);
    });

    it('keeps a declined request hidden after a reload, even when declining it failed', async () => {
      vi.mocked(declineVerificationRequest).mockRejectedValue(new ConnectionError('fetch failed'));
      const { unmount } = render(<SessionOverlay />);
      announce(incoming());
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
      unmount();

      render(<SessionOverlay />);
      announce(incoming());

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('closes an open request when the other device cancels it and says so', async () => {
      await openRequest();

      announce(incoming({ phase: 'cancelled', cancelReason: 'The request timed out.' }));

      expect(screen.queryByText('Incoming verification request')).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('Verification cancelled. The request timed out.');
    });

    it('keeps the open request when another one ends', async () => {
      render(<SessionOverlay />);
      announce(incoming({ id: 'txn-old', fromDeviceId: 'LAPTOPDEVICE', createdAt: Date.now() - 60_000 }));
      announce(incoming());
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));

      announce(incoming({ id: 'txn-old', fromDeviceId: 'LAPTOPDEVICE', phase: 'cancelled', cancelReason: 'The request timed out.' }));

      expect(screen.getByText(/^Device/)).toHaveTextContent(`Device ${OTHER_DEVICE}`);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('goes away when the client stops and stays away after the next sign-in', async () => {
      await openRequest();

      clientStops();
      clientBecomesReady();

      expect(screen.queryByText('Incoming verification request')).not.toBeInTheDocument();
      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it.each(PANELS)('holds a request back while the %s panel is open', (_name, mode) => {
      render(<SessionOverlay />);
      announce(incoming());

      openPanel(mode);

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });
  });

  describe('dismissing a request', () => {
    it('hides the request', async () => {
      render(<SessionOverlay />);
      announce(incoming());

      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('keeps the request hidden when it is announced again after a reload', async () => {
      const { unmount } = render(<SessionOverlay />);
      announce(incoming());
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      unmount();

      render(<SessionOverlay />);
      announce(incoming({ phase: 'ready' }));

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('still hides a dismissed request when the browser blocks storage', async () => {
      const blocked = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      };
      vi.spyOn(localStorage, 'getItem').mockImplementation(blocked);
      vi.spyOn(localStorage, 'setItem').mockImplementation(blocked);
      render(<SessionOverlay />);
      announce(incoming());

      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });

    it('shows the request again once a day has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { unmount } = render(<SessionOverlay />);
      announce(incoming());
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      unmount();
      vi.setSystemTime(Date.now() + DAY);

      render(<SessionOverlay />);
      announce(incoming({ phase: 'ready' }));

      expect(screen.getByText('Verification requested')).toBeInTheDocument();
    });
  });

  describe('verifying this session from the Verify panel', () => {
    /* Starts the request the way the verification module does, which publishes it before returning it */
    const startsVerification = () =>
      vi.mocked(requestVerificationForMyOtherSessions).mockImplementation(async () => {
        const snap = mine();
        publish(snap);
        return snap;
      });

    const startVerification = async () => {
      startsVerification();
      render(<SessionOverlay />);
      openPanel('verification');
      await userEvent.click(screen.getByRole('button', { name: 'Start Verification' }));
    };

    const emojiShown = () => announce(mine({ phase: 'showing_sas', fromDeviceId: OTHER_DEVICE, ...SAS }));

    it('asks my other devices and waits for the emoji code', async () => {
      startsVerification();
      render(<SessionOverlay />);
      openPanel('verification');

      await userEvent.click(screen.getByRole('button', { name: 'Start Verification' }));

      expect(requestVerificationForMyOtherSessions).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Verification started');
      expect(screen.getByText('Waiting for the emoji code…')).toBeInTheDocument();
    });

    it('says why the request could not be sent and offers to start again', async () => {
      vi.mocked(requestVerificationForMyOtherSessions).mockRejectedValue(new Error('Encryption is not ready yet.'));
      render(<SessionOverlay />);
      openPanel('verification');

      await userEvent.click(screen.getByRole('button', { name: 'Start Verification' }));

      expect(toast.error).toHaveBeenCalledWith('Encryption is not ready yet.');
      expect(screen.getByRole('button', { name: 'Start Verification' })).toBeEnabled();
      expect(screen.queryByText('Waiting for the emoji code…')).not.toBeInTheDocument();
    });

    it('shows the emoji to compare once one of my devices accepts', async () => {
      await startVerification();

      emojiShown();

      const comparison = screen.getByText('Do the emojis match?').parentElement!;
      expect(comparison).toHaveTextContent(SAS.sasEmojis.join(''));
      expect(comparison).toHaveTextContent('Code: 4127 - 6250 - 1876');
      expect(within(comparison).getByRole('button', { name: 'Yes' })).toBeEnabled();
    });

    it('closes as soon as Yes confirms the match', async () => {
      await startVerification();
      emojiShown();

      await userEvent.click(screen.getByRole('button', { name: 'Yes' }));

      expect(confirmVerificationRequest).toHaveBeenCalledWith('txn-mine');
      expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    });

    it('says the session is verified when the other device had already confirmed', async () => {
      vi.mocked(confirmVerificationRequest).mockImplementation(async () => {
        publish(mine({ phase: 'done', fromDeviceId: OTHER_DEVICE }));
        return true;
      });
      await startVerification();
      emojiShown();

      await userEvent.click(screen.getByRole('button', { name: 'Yes' }));

      expect(toast.success).toHaveBeenCalledWith('This session is verified');
      expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    });

    it('reports emoji that do not match with No and offers to start again', async () => {
      vi.mocked(declineVerificationRequest).mockImplementation(async () => {
        publish(mine({ phase: 'cancelled', fromDeviceId: OTHER_DEVICE, cancelReason: "The emoji didn't match." }));
        return true;
      });
      await startVerification();
      emojiShown();

      await userEvent.click(screen.getByRole('button', { name: 'No' }));

      expect(declineVerificationRequest).toHaveBeenCalledWith('txn-mine');
      expect(screen.getByRole('alert')).toHaveTextContent("Verification cancelled. The emoji didn't match.");
      expect(screen.getByRole('button', { name: 'Start Verification' })).toBeEnabled();
    });

    it('shows why its request ended and offers to start again', async () => {
      await startVerification();

      announce(mine({ phase: 'cancelled', cancelReason: 'The request timed out.' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Verification cancelled. The request timed out.');
      expect(screen.getByRole('button', { name: 'Start Verification' })).toBeEnabled();
    });

    it('withdraws its request when closed while waiting, and never offers it as an incoming one', async () => {
      await startVerification();

      await userEvent.click(screen.getByRole('button', { name: 'Close' }));

      expect(cancelVerificationRequest).toHaveBeenCalledWith('txn-mine');
      expect(screen.queryByText('Verification requested')).not.toBeInTheDocument();
    });
  });

  describe('creating a Recovery Key', () => {
    const openCreatePanel = () => {
      render(<SessionOverlay />);
      openPanel('recovery_create');
    };

    const unreadableBackup = (keyCount?: number) =>
      new BackupReplaceConfirmationError({ kind: 'unreadable', version: '4', keyCount });

    it('creates a key that leaves the existing backup alone and shows it', async () => {
      vi.mocked(createRecoveryKey).mockResolvedValue({ recoveryKey: KEY, backup: 'kept' });
      openCreatePanel();

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(createRecoveryKey).toHaveBeenCalledWith({ replaceUnreadableBackup: false });
      expect(shownKey()).toHaveTextContent(KEY);
    });

    it.each([
      ['saying how many message keys it holds', 120, 'permanently delete that backup and the 120 message keys in it, so'],
      ['whose size is unknown', undefined, 'permanently delete that backup, so'],
    ])('asks before deleting a backup this device cannot read, %s', async (_case, keyCount, consequence) => {
      vi.mocked(createRecoveryKey).mockRejectedValue(unreadableBackup(keyCount));
      openCreatePanel();

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      const warning = screen.getByRole('alert');
      expect(warning).toHaveTextContent("Your account already has a key backup this device can't read.");
      expect(warning).toHaveTextContent(consequence);
      expect(within(warning).getByRole('button', { name: 'Delete backup and create key' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
      expect(shownKey()).not.toBeInTheDocument();
    });

    it("never shows the previous session's backup warning to the next account", async () => {
      vi.mocked(createRecoveryKey).mockRejectedValue(unreadableBackup(120));
      openCreatePanel();
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      clientStops();
      clientBecomesReady();
      openPanel('recovery_create');

      expect(screen.queryByRole('button', { name: 'Delete backup and create key' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    });

    it('deletes the unreadable backup once the user confirms and shows the new key', async () => {
      vi.mocked(createRecoveryKey)
        .mockRejectedValueOnce(unreadableBackup(120))
        .mockResolvedValueOnce({ recoveryKey: KEY, backup: 'replaced' });
      openCreatePanel();
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      await userEvent.click(screen.getByRole('button', { name: 'Delete backup and create key' }));

      expect(createRecoveryKey).toHaveBeenLastCalledWith({ replaceUnreadableBackup: true });
      expect(shownKey()).toHaveTextContent(KEY);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows a key that is already in use with a warning when its backup could not be set up', async () => {
      const cause = new MatrixError({ errcode: 'M_UNKNOWN', error: 'Internal server error' }, 500);
      vi.mocked(createRecoveryKey).mockRejectedValue(new RecoveryKeyIncompleteError(KEY, cause));
      openCreatePanel();

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(shownKey()).toHaveTextContent(KEY);
      expect(
        screen.getByText("This is your Recovery Key now, but the key backup couldn't be set up. Save the key, then use New key to try again.")
      ).toBeInTheDocument();
    });

    it('says a key could not be created and offers to try again', async () => {
      vi.mocked(createRecoveryKey).mockRejectedValue(new ConnectionError('fetch failed'));
      openCreatePanel();

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(screen.getByText("Couldn't create a Recovery Key. Check your connection and try again.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
      expect(shownKey()).not.toBeInTheDocument();
    });

    it('replaces the key with New key, again leaving the backup alone', async () => {
      vi.mocked(createRecoveryKey)
        .mockResolvedValueOnce({ recoveryKey: KEY, backup: 'created' })
        .mockResolvedValueOnce({ recoveryKey: NEW_KEY, backup: 'kept' });
      openCreatePanel();
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      await userEvent.click(screen.getByRole('button', { name: 'Generate new key' }));

      expect(createRecoveryKey).toHaveBeenLastCalledWith({ replaceUnreadableBackup: false });
      expect(shownKey()).toHaveTextContent(NEW_KEY);
    });

    it('sets up one key however often Create is pressed while it is on its way', async () => {
      vi.mocked(createRecoveryKey).mockReturnValue(new Promise(() => {}));
      openCreatePanel();
      const create = screen.getByRole('button', { name: 'Create' });

      await userEvent.click(create);
      await userEvent.click(create);

      expect(createRecoveryKey).toHaveBeenCalledTimes(1);
      expect(create).toBeDisabled();
    });

    it.each(CLOSING)('stays open while the key is being set up, even on %s', async (_way, close) => {
      vi.mocked(createRecoveryKey).mockReturnValue(new Promise(() => {}));
      openCreatePanel();
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      await close();

      expect(screen.getByText('Get Recovery Key')).toBeInTheDocument();
    });
  });

  describe('copying the Recovery Key', () => {
    /* These tests copy to the clipboard that userEvent.setup() provides, as jsdom has none */
    const showCreatedKey = async (user: UserEvent) => {
      vi.mocked(createRecoveryKey).mockResolvedValue({ recoveryKey: KEY, backup: 'created' });
      render(<SessionOverlay />);
      openPanel('recovery_create');
      await user.click(screen.getByRole('button', { name: 'Create' }));
    };

    it('puts the key on the clipboard and says so', async () => {
      const user = userEvent.setup();
      await showCreatedKey(user);

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      expect(await navigator.clipboard.readText()).toBe(KEY);
      expect(toast.success).toHaveBeenCalledWith('Recovery Key copied');
    });

    it('says so when the browser refuses to copy', async () => {
      const user = userEvent.setup();
      await showCreatedKey(user);
      const refusal = new DOMException("Failed to execute 'writeText' on 'Clipboard': Document is not focused.", 'NotAllowedError');
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(refusal);

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      expect(toast.error).toHaveBeenCalledWith('Could not copy');
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe('restoring with a Recovery Key', () => {
    const openRestorePanelWith = async (key: string) => {
      render(<SessionOverlay />);
      openPanel('recovery_restore');
      await userEvent.click(screen.getByRole('textbox', { name: 'Recovery Key' }));
      await userEvent.paste(key);
    };

    it('asks for a key instead of restoring with a blank one', async () => {
      await openRestorePanelWith('   ');

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Please enter your Recovery Key.');
      expect(restoreWithRecoveryKey).not.toHaveBeenCalled();
    });

    it.each([
      ['with the number of message keys it brought back', { imported: 3, total: 5 }, 'Restored 3 of 5 message keys. Encrypted messages should now start decrypting.'],
      ['from a backup that holds no keys yet', { imported: 0, total: 0 }, "Your Recovery Key is correct. Your key backup doesn't hold any message keys yet."],
    ])('reports a restore %s', async (_case, restored, report) => {
      vi.mocked(restoreWithRecoveryKey).mockResolvedValue(restored);
      await openRestorePanelWith(KEY);

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(restoreWithRecoveryKey).toHaveBeenCalledWith(KEY);
      expect(screen.getByText('Recovery Successful')).toBeInTheDocument();
      expect(screen.getByText(report)).toBeInTheDocument();
    });

    it('tells the rest of the app that keys were restored', async () => {
      const restored = eventsOnWindow('matrix-keys-restored');
      vi.mocked(restoreWithRecoveryKey).mockResolvedValue({ imported: 3, total: 5 });
      await openRestorePanelWith(KEY);

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(restored).toHaveLength(1);
    });

    it('closes with Done after a restore', async () => {
      vi.mocked(restoreWithRecoveryKey).mockResolvedValue({ imported: 3, total: 5 });
      await openRestorePanelWith(KEY);
      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      await userEvent.click(screen.getByRole('button', { name: 'Done' }));

      expect(screen.queryByText('Recovery Successful')).not.toBeInTheDocument();
    });

    it.each([
      ['the key is not a Recovery Key', new RecoveryKeyError('invalid-key', "That isn't a valid Recovery Key. Check it and try again.")],
      ['the account has no Recovery Key', new RecoveryKeyError('no-secret-storage', "Your account doesn't have a Recovery Key yet. Use Get Recovery Key to set one up.")],
      ['the key belongs to another account', new RecoveryKeyError('wrong-key', "This Recovery Key doesn't belong to your account. Check it and try again.")],
      ['the server has no backup', new RecoveryKeyError('no-backup', 'Your Recovery Key is correct, but there is no key backup on the server to restore from.')],
      [
        'the backup key is not stored with the Recovery Key',
        new RecoveryKeyError('backup-key-missing', "Your Recovery Key is correct, but your key backup isn't stored with it, so it can't be restored here."),
      ],
      [
        'another device replaced the backup',
        new RecoveryKeyError(
          'backup-replaced',
          "Your Recovery Key is correct, but the key backup on the server was replaced on another device and can't be opened with it."
        ),
      ],
      ['the homeserver cannot be reached', new RecoveryKeyError('unreachable', "Couldn't reach the homeserver. Check your connection and try again.")],
      ['the homeserver fails', new RecoveryKeyError('server-error', "The homeserver couldn't complete the restore (error 502). Try again later.")],
    ])('says why the restore failed when %s', async (_case, error) => {
      vi.mocked(restoreWithRecoveryKey).mockRejectedValue(error);
      await openRestorePanelWith(KEY);

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(screen.getByRole('alert')).toHaveTextContent(error.message);
    });

    it('gives a general reason when the restore fails unexpectedly', async () => {
      vi.mocked(restoreWithRecoveryKey).mockRejectedValue(new Error('Crypto is not initialised'));
      await openRestorePanelWith(KEY);

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(screen.getByRole('alert')).toHaveTextContent('The restore failed. Try again later.');
    });

    it('clears the reason as soon as the key is edited', async () => {
      vi.mocked(restoreWithRecoveryKey).mockRejectedValue(
        new RecoveryKeyError('wrong-key', "This Recovery Key doesn't belong to your account. Check it and try again.")
      );
      await openRestorePanelWith(KEY);
      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      await userEvent.type(screen.getByRole('textbox', { name: 'Recovery Key' }), '{Backspace}');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('disables Recover while the restore runs', async () => {
      vi.mocked(restoreWithRecoveryKey).mockReturnValue(new Promise(() => {}));
      await openRestorePanelWith(KEY);

      await userEvent.click(screen.getByRole('button', { name: 'Recover' }));

      expect(screen.getByRole('button', { name: 'Recover' })).toBeDisabled();
    });
  });

  describe('forgetting this session', () => {
    const watchRouter = () => {
      const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
      vi.mocked(useRouter).mockReturnValue(router);
      return router;
    };

    /* Signs out the way logoutMatrixClient does, which reports the client as stopped before it resolves */
    const signsOut = (serverSignedOut: boolean) =>
      vi.mocked(logoutMatrixClient).mockImplementation(async () => {
        window.__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
        return { serverSignedOut };
      });

    it.each([
      ['ends the session', true, 'success', 'Session forgotten'],
      ["can't be reached", false, 'error', "Local data removed, but the server couldn't be reached to end the session."],
    ] as const)('wipes this session and goes to sign-in when the server %s', async (_case, serverSignedOut, outcome, message) => {
      const router = watchRouter();
      signsOut(serverSignedOut);
      render(<SessionOverlay />);
      openPanel('forget');

      await userEvent.click(screen.getByRole('button', { name: 'Forget session' }));

      expect(logoutMatrixClient).toHaveBeenCalledWith({ forgetDevice: true });
      expect(toast[outcome]).toHaveBeenCalledWith(message);
      expect(router.replace).toHaveBeenCalledWith('/auth');
    });

    it('says it is forgetting and keeps both buttons disabled meanwhile', async () => {
      vi.mocked(logoutMatrixClient).mockReturnValue(new Promise(() => {}));
      render(<SessionOverlay />);
      openPanel('forget');

      await userEvent.click(screen.getByRole('button', { name: 'Forget session' }));

      expect(screen.getByRole('button', { name: 'Forgetting…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    });

    it('leaves no panel open for the next sign-in', async () => {
      watchRouter();
      signsOut(true);
      render(<SessionOverlay />);
      openPanel('forget');
      await userEvent.click(screen.getByRole('button', { name: 'Forget session' }));

      clientBecomesReady();

      expect(screen.queryByText('Forget this session?')).not.toBeInTheDocument();
    });
  });

  describe.each(PANELS)('%s panel', (_name, mode, title) => {
    it.each(CLOSING)('closes with %s', async (_way, close) => {
      render(<SessionOverlay />);
      openPanel(mode);

      await close();

      expect(screen.queryByText(title)).not.toBeInTheDocument();
    });

    it('hides when the client stops', () => {
      render(<SessionOverlay />);
      openPanel(mode);

      clientStops();

      expect(screen.queryByText(title)).not.toBeInTheDocument();
    });

    it('stays closed for whoever signs in next', () => {
      render(<SessionOverlay />);
      openPanel(mode);

      clientStops();
      clientBecomesReady();

      expect(screen.queryByText(title)).not.toBeInTheDocument();
    });
  });
});