/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmVerificationRequest,
  declineVerificationRequest,
  refreshVerificationRequest,
  requestVerificationForMyOtherSessions,
  isOutgoingVerificationRequest,
  restoreEncryptedHistoryFromBackup,
  setRecoveryKey,
  validateRecoveryKey,
  hasCachedRecoveryKey,
  createRecoveryKey,
  VerificationSnapshot,
  logoutMatrixClient,
  resetMatrixCryptoStores,
} from '@/app/utils/matrix';
import { formatAge, isMatrixReady, hardClientReset } from '@/app/utils/helpers';
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
  const [createdKey, setCreatedKey] = useState<string>('');
  const [createStatus, setCreateStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [createMessage, setCreateMessage] = useState<string>('');

  /* While autoAdvance is set, an accepted outgoing request opens the SAS panel automatically */
  const [autoAdvance, setAutoAdvance] = useState(false);
  const autoStartAtRef = useRef<number>(0);
  const lastAutoHandledIdRef = useRef<string>('');
  const [panelVerificationId, setPanelVerificationId] = useState<string | null>(null);
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
    const onReady = () => setMatrixReadyTick((v) => v + 1);
    const onNotReady = () => setMatrixReadyTick((v) => v + 1);
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
      autoStartAtRef.current = 0;
      lastAutoHandledIdRef.current = '';
    };

    /* Opens the requested panel when a nexus-encryption-open event fires */
    window.addEventListener('nexus-encryption-open', onOpen as any);
    return () => window.removeEventListener('nexus-encryption-open', onOpen as any);
  }, []);

  useEffect(() => {
    const onReq = (ev: Event) => {
      if (!isMatrixReady()) return;

      const ce = ev as CustomEvent;
      const snap = ce?.detail as VerificationSnapshot | undefined;
      if (!snap?.id) return;

      if (isVerificationDismissed(snap.id)) return;

      if (snap.phase === 'done' || snap.phase === 'cancelled') {
        addDismissedVerification(snap.id);
        setItems((prev) => {
          const existing = prev[snap.id];
          if (!existing) return prev;
          return { ...prev, [snap.id]: { ...existing, phase: snap.phase, dismissed: true } };
        });
        setOpenId((cur) => (cur === snap.id ? null : cur));
        setPanelVerificationId((cur) => (cur === snap.id ? null : cur));
        return;
      }

      const isOutgoing =
        isOutgoingVerificationRequest(snap.id) ||
        (snap.txnId && isOutgoingVerificationRequest(snap.txnId));

      /* Don't surface incoming toasts for requests initiated here */
      if (isOutgoing && !autoAdvance) return;

      setItems((prev) => {
        const existing = prev[snap.id];
        const merged: UiItem = {
          ...(existing || {}),
          ...snap,
          dismissed: existing?.dismissed ?? false,
        };
        return { ...prev, [snap.id]: merged };
      });

      /* During autoAdvance, route the responding request straight to the panel within 60 seconds */
      if (autoAdvance) {
        const startedAt = autoStartAtRef.current || 0;
        const withinWindow = startedAt > 0 && Date.now() - startedAt < 60_000;
        const alreadyHandled = lastAutoHandledIdRef.current === snap.id;

        if (!alreadyHandled && withinWindow) {
          lastAutoHandledIdRef.current = snap.id;
          setPanelVerificationId(snap.id);
        }
      }
    };

    window.addEventListener('matrix-verification-request', onReq as any);
    return () => window.removeEventListener('matrix-verification-request', onReq as any);
  }, [autoAdvance]);

  const active = useMemo(() => {
    return Object.values(items)
      .filter((x) => !x.dismissed && x.phase !== 'done' && x.phase !== 'cancelled')
      .filter((x) => !isOutgoingVerificationRequest(x.id) && !(x.txnId && isOutgoingVerificationRequest(x.txnId)))
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
    setRecoveryKeyInput('');
    setCreateStatus('idle');
    setCreateMessage('');
    setCreatedKey('');
    setAutoAdvance(false);
    setPanelVerificationId(null);
    autoStartAtRef.current = 0;
    lastAutoHandledIdRef.current = '';
  };

  const closePanel = () => resetPanels();

  const doAcceptOrYes = async (id: string, opts?: { closeOnConfirm?: boolean }) => {
    setBusy(true);
    try {
      const ok = await confirmVerificationRequest(id);
      if (!ok) return;

      if (opts?.closeOnConfirm) {
        permanentlyDismissVerification(id);
        setOpenId((cur) => (cur === id ? null : cur));
        closePanel();
        return;
      }

      const it = items[id];
      const isSasStageLocal = it?.phase === 'showing_sas';

      if (isSasStageLocal) {
        permanentlyDismissVerification(id);
        setOpenId((cur) => (cur === id ? null : cur));
        return;
      }

      setTimeout(() => {
        refreshVerificationRequest(id);
      }, 350);
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
    } finally {
      setBusy(false);
    }
  };

  const startMyVerification = async () => {
    setBusy(true);
    try {
      autoStartAtRef.current = Date.now();
      lastAutoHandledIdRef.current = '';
      setAutoAdvance(true);
      await requestVerificationForMyOtherSessions();
      toast.success('Verification started');
    } catch (e: any) {
      setAutoAdvance(false);
      setPanelVerificationId(null);
      autoStartAtRef.current = 0;
      lastAutoHandledIdRef.current = '';
      toast.error(String(e?.message ?? e ?? 'Failed to start verification'));
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
      /* Check before restoring so the right success message can be shown afterwards */
      const alreadyHadKey = hasCachedRecoveryKey();

      const isValid = await validateRecoveryKey(key);
      if (!isValid) {
        setRecoveryStatus('error');
        setRecoveryMessage('Invalid Recovery Key. Please check and try again.');
        return;
      }

      /* Decode and cache the key first so the backup restore can read it */
      setRecoveryKey(key);
      await restoreEncryptedHistoryFromBackup();

      if (alreadyHadKey) {
        setRecoveryStatus('ok');
        setRecoveryMessage('already_had_keys');
      } else {
        setRecoveryStatus('ok');
        setRecoveryMessage('restored');
        try { window.dispatchEvent(new Event('matrix-keys-restored')); } catch {}
      }
    } catch (e: any) {
      setRecoveryStatus('error');
      const msg = String(e?.message ?? e ?? '');
      if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('key') || msg.toLowerCase().includes('decrypt')) {
        setRecoveryMessage('Invalid Recovery Key. Please check and try again.');
      } else {
        setRecoveryMessage('Recovery failed. Please enter a valid Recovery Key.');
      }
    } finally {
      setBusy(false);
    }
  };

  const doCreateRecoveryKey = async () => {
    setBusy(true);
    setCreateStatus('idle');
    setCreateMessage('');

    try {
      const key = await createRecoveryKey();
      setCreatedKey(String(key || ''));
      setCreateStatus('ok');
      setCreateMessage('');
    } catch (e: any) {
      setCreateStatus('error');
      setCreateMessage(String(e?.message ?? e ?? 'Failed to create recovery key'));
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

  /* Wipes local crypto stores, logs out server-side, and routes to the auth page */
  const doForgetDevice = async () => {
    if (forgetBusy) return;
    setForgetBusy(true);

    let accessToken = '';
    try {
      accessToken = typeof window !== 'undefined' ? localStorage.getItem('mx_access_token') || '' : '';
    } catch {}

    try {
      try { await resetMatrixCryptoStores(); } catch {}

      try { logoutMatrixClient({ forgetDevice: true }); } catch {}
      hardClientReset({ forgetDevice: true });

      if (accessToken) {
        try {
          await fetch('/api/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken }),
          });
        } catch {}
      }

      toast.success('Session forgotten');
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
  const incomingPanelClass = 'relative w-[92vw] max-w-[340px] glass rounded-3xl p-4 border border-border/70 shadow-none';
  const keyPanelClass = 'relative w-[92vw] max-w-[580px] glass rounded-3xl p-4 border border-border/70 shadow-none';
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
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closePanel} />
          <div className={keyPanelClass}>
            <button type="button" aria-label="Close" onClick={closePanel} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Get Recovery Key</div>
              <div className="mt-2 text-xs text-muted-foreground max-w-[46ch] mx-auto">Set up secure backup for your encrypted chat history. Make sure to memorise your key or store it somewhere you can access easily. If you previously created a key, creating a new one will render your current one invalid.</div>
            </div>

            {!createdKey && (
              <div className="mt-3 flex items-center justify-center">
                <Button variant="outline" disabled={busy} onClick={doCreateRecoveryKey} className="px-4 border-border/70 hover:bg-muted/25">Create</Button>
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
                  <div className="flex-1 max-w-full rounded-2xl border border-border/60 bg-background/20 px-4 py-2 text-[11px] leading-relaxed break-all whitespace-normal">
                    {createdKey}
                  </div>
                  <button type="button" onClick={copyCreatedKey} disabled={busy} className="group relative shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl border border-border/60 bg-background/20 hover:bg-muted/25 transition disabled:opacity-60" aria-label="Copy">
                    <CopyIcon className="h-4 w-4 text-foreground/80 group-hover:text-foreground" />
                    <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-foreground/80 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition">Copy</span>
                  </button>
                  <button type="button" onClick={doCreateRecoveryKey} disabled={busy} className="group relative shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl border border-border/60 bg-background/20 hover:bg-muted/25 transition disabled:opacity-60" aria-label="Generate new key">
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
                <div className="text-base font-semibold text-foreground">
                  {recoveryMessage === 'already_had_keys' ? 'Key Verified' : 'Recovery Successful'}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {recoveryMessage === 'already_had_keys'
                    ? 'Your session already has access to your encrypted history.'
                    : 'Your keys have been restored. Encrypted messages should now start decrypting.'}
                </div>
                <div className="mt-3 flex items-center justify-center">
                  <Button variant="outline" onClick={closePanel} className="px-4 border-border/70 hover:bg-muted/25">Done</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center">
                  <div className="text-base font-semibold text-foreground">Use Recovery Key</div>
                  <div className="mt-2 text-xs text-muted-foreground max-w-[46ch] mx-auto">Enter your Recovery Key to recover your encrypted history on this session.</div>
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
                    className="w-full rounded-2xl border border-border/60 bg-background/20 px-4 py-2 text-[11px] font-mono outline-none focus:ring-0"
                  />
                </div>

                <div className="mt-4 flex flex-col items-center">
                  <Button variant="outline" disabled={busy} onClick={doRestore} className="px-4 border-border/70 hover:bg-muted/25">Recover</Button>
                  {recoveryStatus === 'error' && recoveryMessage && (
                    <div className="mt-1.5 text-[11px] text-center text-destructive">{recoveryMessage}</div>
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
          <div className={tightPanelClass}>
            <button type="button" aria-label="Close" onClick={closePanel} disabled={forgetBusy} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition disabled:opacity-60">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Forget this session?</div>

              <div className="mt-4 rounded-2xl border border-border/60 bg-muted/15 p-3 text-center w-fit mx-auto">
                <div className="text-sm font-semibold text-foreground">Before you proceed</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed max-w-[320px]">
                  This will log you out and remove all local encryption keys currently stored in this browser. Your encrypted conversations will become unreadable until you use your Recovery&nbsp;Key to restore access. Make sure that you have created one before you forget this session.
                </div>
              </div>

              <div className="mt-4 flex items-center justify-center">
                <Button variant="outline" disabled={forgetBusy} onClick={doForgetDevice} className="px-4 border-border/50 text-destructive hover:text-destructive hover:bg-destructive/10">
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