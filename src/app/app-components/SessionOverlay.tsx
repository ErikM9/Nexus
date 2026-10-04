/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelVerificationRequest,
  confirmVerificationRequest,
  declineVerificationRequest,
  requestVerificationForMyOtherSessions,
  restoreWithRecoveryKey,
  RecoveryKeyError,
  type RestoredBackup,
  createRecoveryKey,
  BackupReplaceConfirmationError,
  RecoveryKeyIncompleteError,
  type UnreadableBackup,
  VerificationSnapshot,
  logoutMatrixClient,
} from '@/app/utils/matrix';
import { formatAge, isMatrixReady } from '@/app/utils/helpers';
import { Button } from '@/components/ui/button';
import { X, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';

type UiItem = VerificationSnapshot & { dismissed?: boolean };
type OverlayMode = 'verification' | 'recovery_create' | 'recovery_restore' | 'forget' | null;

const DISMISSED_VERIFICATIONS_KEY = 'nexus_dismissed_verifications';

/* Reads dismissed verification IDs from localStorage, pruning entries older than 24 hours */
const getDismissedVerifications = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(DISMISSED_VERIFICATIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const cleaned: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && now - ts < 24 * 60 * 60 * 1000) {
        cleaned[id] = ts;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
};

const addDismissedVerification = (id: string) => {
  try {
    const current = getDismissedVerifications();
    current[id] = Date.now();
    localStorage.setItem(DISMISSED_VERIFICATIONS_KEY, JSON.stringify(current));
  } catch {}
};

const isVerificationDismissed = (id: string): boolean => {
  return !!getDismissedVerifications()[id];
};

const Spinner: React.FC = () => (
  <div className="inline-flex items-center justify-center">
    <div className="h-4 w-4 rounded-full border border-border/70 border-t-transparent animate-spin" />
  </div>
);

const CopyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path d="M9 9h10v12H9V9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path
      d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

/* Handles the verification, recovery key, and forget-device overlays for the session */
const SessionOverlay: React.FC = () => {
  const router = useRouter();
  const [items, setItems] = useState<Record<string, UiItem>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<OverlayMode>(null);
  const [recoveryKey, setRecoveryKeyInput] = useState('');
  const [recoveryStatus, setRecoveryStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [recoveryMessage, setRecoveryMessage] = useState<string>('');
  const [restored, setRestored] = useState<RestoredBackup | null>(null);
  const [createdKey, setCreatedKey] = useState<string>('');
  const [createStatus, setCreateStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [createMessage, setCreateMessage] = useState<string>('');
  const [backupToReplace, setBackupToReplace] = useState<UnreadableBackup | null>(null);

  /* While autoAdvance is set, the Verify panel follows its own outgoing request, whose ID the ref mirrors for event handlers */
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [panelVerificationId, setPanelVerificationId] = useState<string | null>(null);
  const panelVerificationIdRef = useRef<string | null>(null);
  const [panelNotice, setPanelNotice] = useState('');
  const openIdRef = useRef<string | null>(null);
  const [matrixReadyTick, setMatrixReadyTick] = useState(0);
  const [forgetBusy, setForgetBusy] = useState(false);

  const dismissToast = (id: string) => {
    setItems((prev) => {
      const existing = prev[id];
      if (!existing) return prev;
      return { ...prev, [id]: { ...existing, dismissed: true } };
    });
  };

  const permanentlyDismissVerification = (id: string) => {
    addDismissedVerification(id);
    dismissToast(id);
  };

  useEffect(() => {
    panelVerificationIdRef.current = panelVerificationId;
  }, [panelVerificationId]);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  useEffect(() => {
    const onReady = () => setMatrixReadyTick((v) => v + 1);
    /* Requests belong to the session that received them, so a stopped or signed-out client takes them along */
    const onNotReady = () => {
      setMatrixReadyTick((v) => v + 1);
      setItems({});
      setOpenId(null);
    };
    window.addEventListener('matrix-ready', onReady as any);
    window.addEventListener('matrix-not-ready', onNotReady as any);
    return () => {
      window.removeEventListener('matrix-ready', onReady as any);
      window.removeEventListener('matrix-not-ready', onNotReady as any);
    };
  }, []);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      if (!isMatrixReady()) return;

      const ce = ev as CustomEvent;
      const incomingMode = ce?.detail?.mode as any;
      const incomingTab = ce?.detail?.tab as any;

      let nextMode: OverlayMode = null;

      if (incomingMode === 'verification') nextMode = 'verification';
      if (incomingMode === 'recovery_create') nextMode = 'recovery_create';
      if (incomingMode === 'recovery_restore') nextMode = 'recovery_restore';
      if (incomingMode === 'forget') nextMode = 'forget';

      if (incomingMode === 'recovery') {
        nextMode = incomingTab === 'create' ? 'recovery_create' : 'recovery_restore';
      }

      if (!nextMode) return;

      setMode(nextMode);
      setOpenId(null);
      setRecoveryStatus('idle');
      setRecoveryMessage('');
      setRecoveryKeyInput('');
      setCreateStatus('idle');
      setCreateMessage('');
      setCreatedKey('');
      setAutoAdvance(false);
      setPanelVerificationId(null);
      setPanelNotice('');
    };

    /* Opens the requested panel when a nexus-encryption-open event fires */
    window.addEventListener('nexus-encryption-open', onOpen as any);
    return () => window.removeEventListener('nexus-encryption-open', onOpen as any);
  }, []);

  /* Keeps every request snapshot, including ones announced before the client was ready, and reacts when one ends */
  useEffect(() => {
    const onReq = (ev: Event) => {
      const snap = (ev as CustomEvent<VerificationSnapshot | undefined>).detail;
      if (!snap?.id) return;

      const isPanelRequest = snap.id === panelVerificationIdRef.current;
      if (snap.outgoing && !isPanelRequest) return;
      if (!isPanelRequest && isVerificationDismissed(snap.id)) return;

      const ended = snap.phase === 'done' || snap.phase === 'cancelled';
      setItems((prev) => {
        const existing = prev[snap.id];
        if (ended && !existing) return prev;
        return { ...prev, [snap.id]: { ...(existing || {}), ...snap, dismissed: existing?.dismissed || ended } };
      });

      if (!ended) return;
      const reason = snap.cancelReason ? ` ${snap.cancelReason}` : '';
      if (isPanelRequest) {
        setAutoAdvance(false);
        setPanelVerificationId(null);
        if (snap.phase === 'done') {
          toast.success('This session is verified');
          setMode(null);
        } else {
          setPanelNotice(`Verification cancelled.${reason}`);
        }
        return;
      }

      addDismissedVerification(snap.id);
      if (openIdRef.current === snap.id) {
        setOpenId(null);
        if (snap.phase === 'cancelled') toast.error(`Verification cancelled.${reason}`);
      }
    };

    window.addEventListener('matrix-verification-request', onReq);
    return () => window.removeEventListener('matrix-verification-request', onReq);
  }, []);

  const active = useMemo(() => {
    return Object.values(items)
      .filter((x) => !x.dismissed && !x.outgoing && x.phase !== 'done' && x.phase !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [items]);

  const toastItem = active[0];
  const modalItem = openId ? items[openId] : null;
  const panelItem = panelVerificationId ? items[panelVerificationId] : null;
  const panelIsSasStage = panelItem?.phase === 'showing_sas';

  useEffect(() => {
    if (!openId) return;
    const it = items[openId];
    if (!it) { setOpenId(null); return; }
    if (it.phase === 'done' || it.phase === 'cancelled') setOpenId(null);
  }, [items, openId]);

  const openModal = (id: string) => setOpenId(id);
  const closeModal = () => setOpenId(null);

  const resetPanels = () => {
    setMode(null);
    setRecoveryStatus('idle');
    setRecoveryMessage('');
    setRestored(null);
    setRecoveryKeyInput('');
    setCreateStatus('idle');
    setCreateMessage('');
    setCreatedKey('');
    setBackupToReplace(null);
    setAutoAdvance(false);
    setPanelVerificationId(null);
    setPanelNotice('');
  };

  /* Closing the Verify panel withdraws its outgoing request, so the other device can't start a comparison nobody sees */
  const closePanel = () => {
    const pending = panelVerificationId ? items[panelVerificationId] : null;
    if (pending && pending.phase !== 'done' && pending.phase !== 'cancelled') {
      void cancelVerificationRequest(pending.id).catch(() => {});
    }
    resetPanels();
  };

  const doAcceptOrYes = async (id: string, opts?: { closeOnConfirm?: boolean }) => {
    setBusy(true);
    try {
      await confirmVerificationRequest(id);

      if (opts?.closeOnConfirm) {
        permanentlyDismissVerification(id);
        setOpenId((cur) => (cur === id ? null : cur));
        resetPanels();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error && e.message ? e.message : "Verification couldn't continue.");
    } finally {
      setBusy(false);
    }
  };

  const doDeclineOrNo = async (id: string) => {
    permanentlyDismissVerification(id);
    setOpenId((cur) => (cur === id ? null : cur));

    setBusy(true);
    try {
      await declineVerificationRequest(id);
    } catch (e: unknown) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't decline the request.");
    } finally {
      setBusy(false);
    }
  };

  const startMyVerification = async () => {
    setBusy(true);
    setPanelNotice('');
    try {
      setAutoAdvance(true);
      const snap = await requestVerificationForMyOtherSessions();
      panelVerificationIdRef.current = snap.id;
      setPanelVerificationId(snap.id);
      setItems((prev) => ({ ...prev, [snap.id]: { ...prev[snap.id], ...snap } }));
      toast.success('Verification started');
    } catch (e: unknown) {
      setAutoAdvance(false);
      setPanelVerificationId(null);
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't start verification");
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    const key = recoveryKey.trim();

    if (!key) {
      setRecoveryStatus('error');
      setRecoveryMessage('Please enter your Recovery Key.');
      return;
    }

    setBusy(true);
    setRecoveryStatus('idle');
    setRecoveryMessage('');

    try {
      setRestored(await restoreWithRecoveryKey(key));
      setRecoveryStatus('ok');
      try { window.dispatchEvent(new Event('matrix-keys-restored')); } catch {}
    } catch (e: unknown) {
      setRecoveryStatus('error');
      setRecoveryMessage(e instanceof RecoveryKeyError ? e.message : 'The restore failed. Try again later.');
    } finally {
      setBusy(false);
    }
  };

  /* Creating a key never deletes a backup this device can't read unless the user confirmed it in the panel */
  const doCreateRecoveryKey = async (replaceUnreadableBackup = false) => {
    setBusy(true);
    setCreateStatus('idle');
    setCreateMessage('');

    try {
      const { recoveryKey: created } = await createRecoveryKey({ replaceUnreadableBackup });
      setBackupToReplace(null);
      setCreatedKey(created);
      setCreateStatus('ok');
    } catch (e: unknown) {
      if (e instanceof BackupReplaceConfirmationError) {
        setBackupToReplace(e.backup);
      } else if (e instanceof RecoveryKeyIncompleteError) {
        setBackupToReplace(null);
        setCreatedKey(e.recoveryKey);
        setCreateStatus('error');
        setCreateMessage("This is your Recovery Key now, but the key backup couldn't be set up. Save the key, then use New key to try again.");
      } else {
        setCreateStatus('error');
        setCreateMessage("Couldn't create a Recovery Key. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const copyCreatedKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success('Recovery Key copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  /* Signs out on the server and wipes every account's Matrix data from this browser, then routes to the auth page */
  const doForgetDevice = async () => {
    if (forgetBusy) return;
    setForgetBusy(true);

    try {
      const { serverSignedOut } = await logoutMatrixClient({ forgetDevice: true });
      if (serverSignedOut) toast.success('Session forgotten');
      else toast.error("Local data removed, but the server couldn't be reached to end the session.");
      closePanel();
      router.replace('/auth');
    } finally {
      setForgetBusy(false);
    }
  };

  const isSasStageIncomingModal = modalItem?.phase === 'showing_sas';
  const showVerifyPanel = mode === 'verification' && isMatrixReady();
  const showCreatePanel = mode === 'recovery_create' && isMatrixReady();
  const showRestorePanel = mode === 'recovery_restore' && isMatrixReady();
  const showForgetPanel = mode === 'forget' && isMatrixReady();

  const showIncoming =
    !showVerifyPanel && !showCreatePanel && !showRestorePanel && !showForgetPanel && !autoAdvance && isMatrixReady() && (toastItem || modalItem);

  if (!showVerifyPanel && !showCreatePanel && !showRestorePanel && !showForgetPanel && !showIncoming) return null;

  void matrixReadyTick;

  const tightPanelClass = 'relative w-[92vw] max-w-[390px] glass rounded-3xl p-4 border border-border/70 shadow-none';
  const forgetPanelClass = 'relative w-[92vw] max-w-[360px] glass rounded-3xl p-4 border border-border/70 shadow-none';
  const incomingPanelClass = 'relative w-[92vw] max-w-[340px] glass rounded-3xl p-4 border border-border/70 shadow-none';
  const keyPanelClass = 'relative w-[92vw] max-w-[540px] glass rounded-3xl p-4 border border-border/70 shadow-none';
  const restorePanelClass = 'relative w-[92vw] max-w-[510px] glass rounded-3xl p-4 border border-border/70 shadow-none';

  return (
    <>

      {toastItem && showIncoming && openId !== toastItem.id && (
        <div className="fixed bottom-5 right-5 z-[80]">
          <div className="glass rounded-2xl px-4 py-3 border border-border/60 shadow-none">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="text-sm font-semibold text-foreground text-center">Verification requested</div>
                <div className="text-xs text-muted-foreground mt-0.5 text-center">
                  From <span className="font-medium text-foreground/90">{toastItem.fromUserId}</span>
                  {toastItem.fromDeviceId ? (
                    <> · device <span className="font-medium text-foreground/90">{toastItem.fromDeviceId}</span></>
                  ) : null}{' '}
                  · {formatAge(toastItem.createdAt)}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 border-border/70 hover:bg-muted/25"
                  onClick={() => openModal(toastItem.id)}
                >
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 border-border/70 hover:bg-muted/25"
                  onClick={() => permanentlyDismissVerification(toastItem.id)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalItem && showIncoming && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closeModal} />

          <div className={isSasStageIncomingModal ? tightPanelClass : incomingPanelClass}>
            <button
              type="button"
              aria-label="Close"
              onClick={closeModal}
              className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">
                {isSasStageIncomingModal ? 'Verify this session' : 'Incoming verification request'}
              </div>

              <div className="text-sm text-muted-foreground mt-1.5">
                <div>
                  From <span className="font-medium text-foreground/90">{modalItem.fromUserId}</span>
                </div>
                {modalItem.fromDeviceId ? (
                  <div className="mt-0.5">
                    Device <span className="font-medium text-foreground/90">{modalItem.fromDeviceId}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {isSasStageIncomingModal ? (
              <div className="mt-4 rounded-2xl border border-border/60 bg-muted/20 p-3 text-center w-fit mx-auto">
                <div className="text-sm font-semibold text-foreground">Do the emojis match?</div>

                {modalItem.sasEmojis?.length ? (
                  <div className="mt-3 text-sm text-foreground/90 flex flex-wrap justify-center gap-x-2 gap-y-1">
                    {modalItem.sasEmojis.map((e, i) => (
                      <span key={`${e}-${i}`} className="px-2 py-1 rounded-full bg-muted/30 border border-border/50">
                        {e}
                      </span>
                    ))}
                  </div>
                ) : null}

                {modalItem.sasDecimals?.length ? (
                  <div className="mt-3 text-xs text-muted-foreground tracking-wider">
                    Code: <span className="text-foreground/90">{modalItem.sasDecimals.join(' - ')}</span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-border/60 bg-muted/15 p-3 text-center w-fit mx-auto">
                <div className="text-sm font-semibold text-foreground">Accept this request?</div>
                <div className="mt-1 text-xs text-muted-foreground">Next you&apos;ll compare an emoji code.</div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-center gap-3">
              {isSasStageIncomingModal ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => doAcceptOrYes(modalItem.id, { closeOnConfirm: true })} className="px-4 border-border/70 hover:bg-muted/25">Yes</Button>
                  <Button variant="outline" disabled={busy} onClick={() => doDeclineOrNo(modalItem.id)} className="px-4 border-border/70 hover:bg-muted/25">No</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => doAcceptOrYes(modalItem.id)} className="px-4 border-border/70 hover:bg-muted/25">Accept</Button>
                  <Button variant="outline" disabled={busy} onClick={() => doDeclineOrNo(modalItem.id)} className="px-4 border-border/70 hover:bg-muted/25">Decline</Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showVerifyPanel && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closePanel} />
          <div className={tightPanelClass}>
            <button type="button" aria-label="Close" onClick={closePanel} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Verification</div>

              {!autoAdvance && (
                <>
                  {panelNotice && (
                    <div role="alert" className="mt-2 text-xs text-destructive">{panelNotice}</div>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground">Start a verification request, then compare the emoji code.</div>
                  <div className="mt-3 flex items-center justify-center">
                    <Button variant="outline" disabled={busy} onClick={startMyVerification} className="px-4 border-border/70 hover:bg-muted/25">
                      Start Verification
                    </Button>
                  </div>
                </>
              )}

              {autoAdvance && !panelIsSasStage && (
                <div className="mt-4 rounded-2xl border border-border/60 bg-muted/15 p-3 w-fit mx-auto">
                  <div className="text-sm font-semibold text-foreground flex items-center justify-center gap-2">
                    <Spinner />
                    Waiting for the emoji code…
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground text-center">Accept on your other device. This updates automatically.</div>
                </div>
              )}

              {autoAdvance && panelIsSasStage && panelItem && (
                <div className="mt-4 rounded-2xl border border-border/60 bg-muted/20 p-3 text-center w-fit mx-auto">
                  <div className="text-sm font-semibold text-foreground">Do the emojis match?</div>

                  {panelItem.sasEmojis?.length ? (
                    <div className="mt-3 text-sm text-foreground/90 flex flex-wrap justify-center gap-x-2 gap-y-1">
                      {panelItem.sasEmojis.map((e, i) => (
                        <span key={`${e}-${i}`} className="px-2 py-1 rounded-full bg-muted/30 border border-border/50">{e}</span>
                      ))}
                    </div>
                  ) : null}

                  {panelItem.sasDecimals?.length ? (
                    <div className="mt-3 text-xs text-muted-foreground tracking-wider">
                      Code: <span className="text-foreground/90">{panelItem.sasDecimals.join(' - ')}</span>
                    </div>
                  ) : null}

                  <div className="mt-4 flex items-center justify-center gap-3">
                    <Button variant="outline" disabled={busy} onClick={() => doAcceptOrYes(panelItem.id, { closeOnConfirm: true })} className="px-4 border-border/70 hover:bg-muted/25">Yes</Button>
                    <Button variant="outline" disabled={busy} onClick={() => doDeclineOrNo(panelItem.id)} className="px-4 border-border/70 hover:bg-muted/25">No</Button>
                  </div>

                  <div className="mt-3 text-xs text-muted-foreground">Panel will close as soon as you confirm here.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showCreatePanel && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center">
          {/* Closing is blocked while a key is being set up, so a key that becomes active is never hidden from the user */}
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={busy ? undefined : closePanel} />
          <div className={keyPanelClass} aria-busy={busy}>
            <button type="button" aria-label="Close" onClick={closePanel} disabled={busy} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition disabled:opacity-50">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Get Recovery Key</div>
              <div className="mt-2 text-xs text-muted-foreground [text-wrap:balance]">Set up secure backup for your encrypted chat history. Memorise your key or store it somewhere safe. If you already have a key, creating a new one makes the old one invalid.</div>
            </div>

            {!createdKey && !backupToReplace && (
              <div className="mt-3 flex items-center justify-center">
                <Button variant="outline" disabled={busy} onClick={() => doCreateRecoveryKey()} className="px-4 border-border/70 hover:bg-muted/25">Create</Button>
              </div>
            )}

            {!createdKey && backupToReplace && (
              <div role="alert" className="mt-3 w-full mx-auto rounded-2xl border border-destructive/40 bg-destructive/10 dark:border-destructive/55 dark:bg-destructive/20 px-4 py-3 text-foreground">
                {/* The warning itself is the larger text, set in even lines across the box; the one-line heading above it is kept small.
                    Closing is the X in the corner, so the only button is the one that goes ahead, with the same slight hover lift as the other buttons */}
                <div className="text-sm leading-5 font-semibold text-center">Your account already has a key backup this device can&apos;t read.</div>
                <div className="mt-1.5 text-sm leading-snug text-muted-foreground text-center [text-wrap:balance]">
                  A new Recovery Key would permanently delete that backup{backupToReplace.keyCount ? ` and the ${backupToReplace.keyCount} message keys in it` : ''}, so older encrypted messages it holds could no longer be decrypted. If you still have your current Recovery Key, use it with Use Recovery Key instead.
                </div>
                <div className="mt-2.5 flex items-center justify-center">
                  <Button variant="destructive" disabled={busy} onClick={() => doCreateRecoveryKey(true)} className="px-4 hover:bg-[hsl(0_84%_66%)] dark:bg-destructive/85 dark:hover:bg-destructive/85 dark:hover:brightness-[1.15] dark:hover:saturate-[1.15] transition-[filter,background-color]">Delete backup and create key</Button>
                </div>
              </div>
            )}

            {createStatus !== 'idle' && createMessage && (
              <div className={['mt-3 text-xs text-center', createStatus === 'ok' ? 'text-foreground/80' : 'text-destructive'].join(' ')}>
                {createMessage}
              </div>
            )}

            {createdKey && (
              <div className="mt-3">
                <div className="flex items-start gap-2 justify-center w-[90%] mx-auto">
                  <output aria-label="Your Recovery Key" className="block flex-1 max-w-full rounded-2xl border border-border/60 bg-background/20 px-4 py-2 text-[11px] leading-relaxed break-all whitespace-normal">
                    {createdKey}
                  </output>
                  <button type="button" onClick={copyCreatedKey} disabled={busy} className="group relative shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl border border-border/60 bg-background/20 hover:bg-muted/25 transition disabled:opacity-60" aria-label="Copy">
                    <CopyIcon className="h-4 w-4 text-foreground/80 group-hover:text-foreground" />
                    <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-foreground/80 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition">Copy</span>
                  </button>
                  <button type="button" onClick={() => doCreateRecoveryKey()} disabled={busy} className="group relative shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl border border-border/60 bg-background/20 hover:bg-muted/25 transition disabled:opacity-60" aria-label="Generate new key">
                    <RefreshCw className="h-4 w-4 text-foreground/80 group-hover:text-foreground" />
                    <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-foreground/80 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition">New key</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showRestorePanel && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closePanel} />
          <div className={recoveryStatus === 'ok' ? tightPanelClass : restorePanelClass}>
            <button type="button" aria-label="Close" onClick={closePanel} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition">
              <X className="h-5 w-5" />
            </button>

            {recoveryStatus === 'ok' ? (
              <div className="text-center">
                <div className="text-base font-semibold text-foreground">Recovery Successful</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {restored?.total
                    ? `Restored ${restored.imported} of ${restored.total} message keys. Encrypted messages should now start decrypting.`
                    : "Your Recovery Key is correct. Your key backup doesn't hold any message keys yet."}
                </div>
                <div className="mt-3 flex items-center justify-center">
                  <Button variant="outline" onClick={closePanel} className="px-4 border-border/70 hover:bg-muted/25">Done</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center">
                  <div className="text-base font-semibold text-foreground">Use Recovery Key</div>
                  <div className="mt-2 text-xs text-muted-foreground [text-wrap:balance]">Enter your Recovery Key to recover your encrypted history on this session.</div>
                </div>

                <div className="mt-4 flex justify-center w-[90%] mx-auto">
                  <input
                    value={recoveryKey}
                    onChange={(e) => {
                      setRecoveryKeyInput(e.target.value);
                      if (recoveryStatus === 'error') {
                        setRecoveryStatus('idle');
                        setRecoveryMessage('');
                      }
                    }}
                    placeholder="Enter key here"
                    aria-label="Recovery Key"
                    className="w-full rounded-2xl border border-border/60 bg-background/20 px-4 py-2 text-[11px] font-mono outline-none focus:ring-0"
                  />
                </div>

                <div className="mt-4 flex flex-col items-center">
                  <Button variant="outline" disabled={busy} onClick={doRestore} className="px-4 border-border/70 hover:bg-muted/25">Recover</Button>
                  {recoveryStatus === 'error' && recoveryMessage && (
                    <div role="alert" className="mt-1.5 text-[11px] text-center text-destructive">{recoveryMessage}</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showForgetPanel && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closePanel} />
          <div className={forgetPanelClass}>
            <button type="button" aria-label="Close" onClick={closePanel} disabled={forgetBusy} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition disabled:opacity-60">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Forget this session?</div>

              {/* The same faint blue-grey as the sign-up page's explanation, with the warning set in even lines */}
              <div className="mt-4 rounded-2xl border border-[hsl(214_18%_72%/0.5)] bg-[hsl(214_22%_87%/0.6)] dark:border-border/60 dark:bg-muted/15 p-3 text-center w-fit mx-auto">
                <div className="text-sm font-semibold text-foreground">Before you proceed</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed max-w-[296px] [text-wrap:balance]">
                  This will log you out and remove all local encryption keys currently stored in this browser. Your encrypted conversations will become unreadable until you use your Recovery&nbsp;Key to restore access. Make sure that you have created one before you forget this session.
                </div>
              </div>

              <div className="mt-4 flex items-center justify-center">
                {/* The dark theme's destructive token is a background shade, so the label takes a red of its own there. Hovering
                    warms the button the same way in both themes: a soft red tint behind a label that strengthens against it */}
                <Button variant="outline" disabled={forgetBusy} onClick={doForgetDevice} className="px-4 border-border/50 text-destructive hover:text-red-700 hover:bg-[hsl(0_88%_92%)] dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-400/10">
                  {forgetBusy ? 'Forgetting…' : 'Forget session'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SessionOverlay;