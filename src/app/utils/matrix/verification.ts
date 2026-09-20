/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import type { VerificationSnapshot } from './types';
import { state, getMatrixClientOrThrow } from './state';
import { getCryptoModule } from './crypto';
import { emitVerificationSnapshot } from './events';

/* WeakSets track which objects already have listeners without preventing GC */
const reqListenerAttached = new WeakSet<any>();
const verifierListenerAttached = new WeakSet<any>();
const outgoingRequestIds = new Set<string>();

/* Normalises verification request IDs across the several fields different SDK versions expose */

const getTxnId = (req: any): string => {
  const direct = req?.transactionId ?? req?.transaction_id ?? req?.txnId ?? req?.txn_id;
  if (direct) return String(direct);

  try {
    const ev = req?.event;
    const content = typeof ev?.getContent === 'function' ? ev.getContent() : ev?.content;
    const fromEvent = content?.transaction_id ?? content?.transactionId;
    if (fromEvent) return String(fromEvent);
  } catch {}

  return '';
};

const getFlowId = (req: any): string => {
  const direct = req?.flowId ?? req?.flow_id;
  if (direct) return String(direct);
  return '';
};

/* Prefers txnId among the up-to-three request IDs since it's the most commonly indexed */
const getReqId = (req: any): string => {
  const txn = getTxnId(req);
  if (txn) return txn;

  const flow = getFlowId(req);
  if (flow) return flow;

  const id = req?.requestId ?? (typeof req?.event?.getId === 'function' ? req.event.getId() : undefined);
  return String(id || '') || `req_${Math.random().toString(36).slice(2)}`;
};

const getVerifierForAnyId = (id: string): any | null => {
  const direct = state.verifierMap.get(id);
  if (direct) return direct;
  const snap = state.verificationSnapMap.get(id);
  const txnId = snap?.txnId || '';
  if (txnId && state.verifierMap.get(txnId)) return state.verifierMap.get(txnId);
  return null;
};

const extractSasFromVerifier = (verifier: any): { sasEmojis?: string[]; sasDecimals?: number[] } => {
  if (!verifier) return {};
  try {
    const cb = typeof verifier.getShowSasCallbacks === 'function' ? verifier.getShowSasCallbacks() : null;
    const sas = cb?.sas;
    const emoji = sas?.emoji;
    const dec = sas?.decimal;

    const sasEmojis =
      Array.isArray(emoji)
        ? emoji
            .map((e: any) => (Array.isArray(e) ? e[0] : e))
            .map((x: any) => String(x || '').trim())
            .filter(Boolean)
        : undefined;

    const sasDecimals =
      Array.isArray(dec) ? dec.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n)) : undefined;

    return {
      sasEmojis: sasEmojis?.length ? sasEmojis : undefined,
      sasDecimals: sasDecimals?.length ? sasDecimals : undefined,
    };
  } catch {
    return {};
  }
};

/* Derives a normalised phase from the request, checking both phase and state fields */
const derivePhaseFromReq = (req: any, verifier: any | null): VerificationSnapshot['phase'] => {
  const rawPhase = req?.phase ?? (typeof req?.getPhase === 'function' ? req.getPhase() : undefined);
  const p = String(rawPhase ?? '').toLowerCase();

  if (p.includes('done') || p.includes('verified') || p.includes('complete')) return 'done';
  if (p.includes('cancel') || p.includes('reject') || p.includes('abort')) return 'cancelled';
  if (verifier) {
    const sas = extractSasFromVerifier(verifier);
    if (sas.sasEmojis?.length || sas.sasDecimals?.length) return 'showing_sas';
  }
  if (p.includes('ready') || p.includes('accepted') || p.includes('started') || p.includes('start')) return 'ready';
  if (p.includes('request')) return 'requested';

  const stRaw = req?.state ?? req?.status ?? (typeof req?.getState === 'function' ? req.getState() : undefined);
  const st = String(stRaw ?? '').toLowerCase();
  if (st.includes('done') || st.includes('verified') || st.includes('complete')) return 'done';
  if (st.includes('cancel') || st.includes('reject') || st.includes('abort')) return 'cancelled';
  if (st.includes('ready') || st.includes('accepted') || st.includes('started')) return 'ready';

  return 'requested';
};

const snapshotFromReq = (req: any): VerificationSnapshot => {
  const id = getReqId(req);
  const txnId = getTxnId(req) || getFlowId(req) || undefined;
  const fromUserId = String(req?.otherUserId ?? req?.fromUserId ?? req?.sender ?? '') || 'Unknown';
  const fromDeviceId = String(req?.otherDeviceId ?? req?.fromDeviceId ?? req?.from_device ?? '') || undefined;
  const verifier = req?.verifier || getVerifierForAnyId(id);
  const phase = derivePhaseFromReq(req, verifier);
  const existing = state.verificationSnapMap.get(id) || (txnId ? state.verificationSnapMap.get(txnId) : undefined);
  const sas = extractSasFromVerifier(verifier);

  return {
    id,
    txnId: txnId ?? existing?.txnId,
    fromUserId,
    fromDeviceId,
    createdAt: existing?.createdAt ?? Date.now(),
    phase,
    sasEmojis: sas.sasEmojis ?? existing?.sasEmojis,
    sasDecimals: sas.sasDecimals ?? existing?.sasDecimals,
  };
};

/* Stores the request under all of its IDs so any lookup hits regardless of which ID is used */
const upsertVerificationReq = (req: any) => {
  const id = getReqId(req);
  const txnId = getTxnId(req);
  const flowId = getFlowId(req);

  state.verificationReqMap.set(id, req);
  if (txnId) state.verificationReqMap.set(txnId, req);
  if (flowId) state.verificationReqMap.set(flowId, req);

  const snap = snapshotFromReq(req);

  state.verificationSnapMap.set(snap.id, snap);
  if (snap.txnId) state.verificationSnapMap.set(snap.txnId, snap);
  if (txnId) state.verificationSnapMap.set(txnId, snap);
  if (flowId) state.verificationSnapMap.set(flowId, snap);

  emitVerificationSnapshot(snap);
};

const emitSnapshotForId = (id: string, patch: Partial<VerificationSnapshot>) => {
  const base = state.verificationSnapMap.get(id);
  if (!base) return;
  const next: VerificationSnapshot = { ...base, ...patch };
  state.verificationSnapMap.set(next.id, next);
  if (next.txnId) state.verificationSnapMap.set(next.txnId, next);
  emitVerificationSnapshot(next);
};

const attachVerifierListeners = (id: string, req: any, verifier: any) => {
  if (!verifier) return;

  const rid = getReqId(req);
  const txnId = getTxnId(req);
  const flowId = getFlowId(req);

  /* Register the verifier under all known IDs for this request */
  state.verifierMap.set(id, verifier);
  state.verifierMap.set(rid, verifier);
  if (txnId) state.verifierMap.set(txnId, verifier);
  if (flowId) state.verifierMap.set(flowId, verifier);

  if (verifierListenerAttached.has(verifier)) {
    const sas = extractSasFromVerifier(verifier);
    if (sas.sasEmojis?.length || sas.sasDecimals?.length) {
      emitSnapshotForId(id, { phase: 'showing_sas', ...sas });
      emitSnapshotForId(rid, { phase: 'showing_sas', ...sas });
      if (txnId) emitSnapshotForId(txnId, { phase: 'showing_sas', ...sas });
      if (flowId) emitSnapshotForId(flowId, { phase: 'showing_sas', ...sas });
    }
    return;
  }

  verifierListenerAttached.add(verifier);

  const updateSas = () => {
    const sas = extractSasFromVerifier(verifier);
    if (sas.sasEmojis?.length || sas.sasDecimals?.length) {
      emitSnapshotForId(id, { phase: 'showing_sas', ...sas });
      emitSnapshotForId(rid, { phase: 'showing_sas', ...sas });
      if (txnId) emitSnapshotForId(txnId, { phase: 'showing_sas', ...sas });
      if (flowId) emitSnapshotForId(flowId, { phase: 'showing_sas', ...sas });
    }
  };

  const markCancelled = () => {
    emitSnapshotForId(id, { phase: 'cancelled' });
    emitSnapshotForId(rid, { phase: 'cancelled' });
    if (txnId) emitSnapshotForId(txnId, { phase: 'cancelled' });
    if (flowId) emitSnapshotForId(flowId, { phase: 'cancelled' });
  };

  const markDone = () => {
    emitSnapshotForId(id, { phase: 'done' });
    emitSnapshotForId(rid, { phase: 'done' });
    if (txnId) emitSnapshotForId(txnId, { phase: 'done' });
    if (flowId) emitSnapshotForId(flowId, { phase: 'done' });
  };

  try {
    if (typeof verifier.on === 'function') {
      verifier.on('show_sas', updateSas);
      verifier.on('change', updateSas);
      verifier.on('cancel', markCancelled);
      verifier.on('done', markDone);
      verifier.on('finished', markDone);
    }
  } catch {}

  updateSas();
};

const attachReqChangeListener = (req: any) => {
  if (!req || reqListenerAttached.has(req)) return;
  reqListenerAttached.add(req);

  const handler = () => {
    upsertVerificationReq(req);
    if (req?.verifier) attachVerifierListeners(getReqId(req), req, req.verifier);
  };

  try {
    if (typeof req?.on === 'function') {
      req.on('change', handler);
      req.on('changed', handler);
      req.on('update', handler);
      req.on('updated', handler);
    }
  } catch {}
};

/* Collects every ID alias for a request so lookups can try all of them */
const getAllKnownIdsFor = (id: string): string[] => {
  const ids = new Set<string>();
  if (id) ids.add(id);

  const snap = state.verificationSnapMap.get(id);
  if (snap?.id) ids.add(snap.id);
  if (snap?.txnId) ids.add(snap.txnId);

  const req = state.verificationReqMap.get(id);
  if (req) {
    const rid = getReqId(req);
    const txn = getTxnId(req);
    const flow = getFlowId(req);
    if (rid) ids.add(rid);
    if (txn) ids.add(txn);
    if (flow) ids.add(flow);
  }

  return Array.from(ids);
};

const findReqInCrypto = (client: MatrixClient, id: string): any | null => {
  const crypto = getCryptoModule(client);
  if (!crypto) return null;

  const candidates = getAllKnownIdsFor(id);

  for (const cand of candidates) {
    try {
      if (typeof crypto.getVerificationRequest === 'function') {
        const r = crypto.getVerificationRequest(cand);
        if (r) return r;
      }
    } catch {}
  }

  /* Fall back to scanning all pending requests when direct lookup fails */
  try {
    if (typeof crypto.getVerificationRequests === 'function') {
      const pending = crypto.getVerificationRequests();
      if (Array.isArray(pending)) {
        for (const r of pending) {
          const rid = getReqId(r);
          const txn = getTxnId(r);
          const flow = getFlowId(r);
          if (candidates.includes(rid) || (txn && candidates.includes(txn)) || (flow && candidates.includes(flow))) {
            return r;
          }
        }
      }
    }
  } catch {}

  return null;
};

/* Tries local maps first, then asks the SDK directly as a fallback */
const resolveVerificationRequest = (id: string): any | null => {
  const direct = state.verificationReqMap.get(id);
  if (direct) return direct;

  const snap = state.verificationSnapMap.get(id);
  const anyId = snap?.txnId || id;
  const direct2 = state.verificationReqMap.get(anyId);
  if (direct2) return direct2;

  try {
    const client = getMatrixClientOrThrow();
    const r = findReqInCrypto(client, id);
    if (r) {
      upsertVerificationReq(r);
      attachReqChangeListener(r);
      if (r?.verifier) attachVerifierListeners(getReqId(r), r, r.verifier);
      return r;
    }
  } catch {}

  return null;
};

export const refreshVerificationRequest = (id: string) => {
  try {
    const client = getMatrixClientOrThrow();
    const r = resolveVerificationRequest(id) || findReqInCrypto(client, id);
    if (!r) return false;
    upsertVerificationReq(r);
    attachReqChangeListener(r);
    if (r?.verifier) attachVerifierListeners(getReqId(r), r, r.verifier);
    return true;
  } catch {
    return false;
  }
};

/* Resolves once the request has a verifier or advances past the requested phase, or times out */
const waitForReqReadyOrVerifier = (req: any, timeoutMs = 30000): Promise<void> =>
  new Promise((resolve) => {
    const isReady = () => {
      if (req?.verifier) return true;
      const rawPhase = req?.phase ?? (typeof req?.getPhase === 'function' ? req.getPhase() : undefined);
      const p = String(rawPhase ?? '').toLowerCase();
      return p.includes('ready') || p.includes('accepted') || p.includes('started') || p.includes('start');
    };

    if (isReady()) { resolve(); return; }

    const timer = setTimeout(resolve, timeoutMs);
    const cleanup = () => { clearTimeout(timer); resolve(); };

    try {
      if (typeof req?.on === 'function') {
        const handler = () => { if (isReady()) cleanup(); };
        req.on('change', handler);
        req.on('changed', handler);
        req.on('update', handler);
      }
    } catch {}
  });

/* Guards against double-attachment so listeners attach only once per session */
export const attachVerificationListeners = (client: MatrixClient) => {
  if (state.verificationListenersAttached) return;
  state.verificationListenersAttached = true;

  const onReq = (req: any) => {
    try {
      const id = getReqId(req);
      upsertVerificationReq(req);
      attachReqChangeListener(req);
      if (req?.verifier) attachVerifierListeners(id, req, req.verifier);
    } catch (e) {
      console.error('attachVerificationListeners: failed to handle request', e);
    }
  };

  try { (client as any).on?.('crypto.verificationRequestReceived', onReq); } catch {}

  /* Subscribe to every event name the SDK might use */
  try {
    const crypto = getCryptoModule(client);
    if (crypto?.on) {
      const events = [
        'verificationRequestReceived',
        'verificationRequestUpdated',
        'request',
        'm.key.verification.request',
        'crypto.verificationRequestReceived',
        'Crypto.verificationRequestReceived',
      ];
      for (const ev of events) {
        try { crypto.on(ev, onReq); } catch {}
      }
    }
  } catch {}

  /* Pick up any requests that arrived before listeners attached */
  try {
    const crypto = getCryptoModule(client);
    if (crypto?.getVerificationRequests) {
      const pending = crypto.getVerificationRequests();
      if (Array.isArray(pending)) pending.forEach((r: any) => onReq(r));
    }
  } catch {}

  /* Watch to-device events directly since some SDK versions don't surface requests via crypto */
  try {
    client.on(ClientEvent.ToDeviceEvent as any, (ev: any) => {
      try {
        const type = typeof ev?.getType === 'function' ? String(ev.getType() || '') : String(ev?.type ?? '');
        if (!type.startsWith('m.key.verification.')) return;

        const content = typeof ev?.getContent === 'function' ? (ev.getContent() as any) : (ev?.content as any);
        const txnId = String(content?.transaction_id ?? content?.transactionId ?? '') || '';
        const flowId = String(content?.flow_id ?? content?.flowId ?? '') || '';
        const fromUserId =
          (typeof ev?.getSender === 'function' ? String(ev.getSender() || '') : String(ev?.sender ?? '')) || 'Unknown';
        const fromDeviceId = String(content?.from_device ?? '') || undefined;
        const id = txnId || flowId || `ver_${Math.random().toString(36).slice(2)}`;
        const existing =
          state.verificationSnapMap.get(id) ||
          (txnId ? state.verificationSnapMap.get(txnId) : undefined) ||
          (flowId ? state.verificationSnapMap.get(flowId) : undefined);

        const snap: VerificationSnapshot = {
          id,
          txnId: txnId || flowId || existing?.txnId,
          fromUserId,
          fromDeviceId,
          createdAt: existing?.createdAt ?? Date.now(),
          phase: existing?.phase ?? 'requested',
          sasEmojis: existing?.sasEmojis,
          sasDecimals: existing?.sasDecimals,
        };

        state.verificationSnapMap.set(id, snap);
        if (txnId) state.verificationSnapMap.set(txnId, snap);
        if (flowId) state.verificationSnapMap.set(flowId, snap);
        if (snap.txnId) state.verificationSnapMap.set(snap.txnId, snap);

        emitVerificationSnapshot(snap);

        const req = resolveVerificationRequest(id);
        if (req) {
          upsertVerificationReq(req);
          attachReqChangeListener(req);
          if (req?.verifier) attachVerifierListeners(getReqId(req), req, req.verifier);
        }
      } catch {}
    });
  } catch {}
};

export const confirmVerificationRequest = async (id: string) => {
  const req = resolveVerificationRequest(id);
  if (!req) {
    console.error('confirmVerificationRequest: could not resolve request for id', id);
    return false;
  }

  const rid = getReqId(req);
  const txnId = getTxnId(req);
  const flowId = getFlowId(req);
  const verifier = req?.verifier || getVerifierForAnyId(id) || getVerifierForAnyId(rid);

  /* An existing verifier with SAS callbacks just needs emoji confirmation, not a restart */
  if (verifier && typeof verifier.getShowSasCallbacks === 'function') {
    const cb = verifier.getShowSasCallbacks();
    if (cb?.confirm) {
      try {
        await cb.confirm();
        upsertVerificationReq(req);
        refreshVerificationRequest(id);
        if (txnId) refreshVerificationRequest(txnId);
        if (flowId) refreshVerificationRequest(flowId);
        return true;
      } catch (e) {
        console.error('confirmVerificationRequest: sas confirm failed', e);
        upsertVerificationReq(req);
        return false;
      }
    }
  }

  try {
    if (typeof req.accept === 'function') await req.accept();
  } catch (e) {
    console.error('confirmVerificationRequest: accept failed', e);
  }

  try { await waitForReqReadyOrVerifier(req, 5000); } catch {}

  let v = req?.verifier || getVerifierForAnyId(id) || getVerifierForAnyId(rid);

  if (!v) {
    try {
      if (typeof req.startVerification === 'function') {
        v = await req.startVerification('m.sas.v1');
      }
    } catch (e) {
      console.error('confirmVerificationRequest: startVerification failed', e);
    }
  }

  if (!v) {
    upsertVerificationReq(req);
    console.error('confirmVerificationRequest: no verifier available after accept/start', { id, rid, txnId, flowId });
    return false;
  }

  attachVerifierListeners(id, req, v);
  attachVerifierListeners(rid, req, v);
  if (txnId) attachVerifierListeners(txnId, req, v);
  if (flowId) attachVerifierListeners(flowId, req, v);

  if (typeof v.verify === 'function') {
    try {
      void v.verify().then(
        () => {
          try {
            upsertVerificationReq(req);
            refreshVerificationRequest(id);
            if (txnId) refreshVerificationRequest(txnId);
            if (flowId) refreshVerificationRequest(flowId);
          } catch {}
        },
        (e: any) => {
          console.error('confirmVerificationRequest: verifier.verify failed', e);
          try { upsertVerificationReq(req); } catch {}
        }
      );
    } catch (e) {
      console.error('confirmVerificationRequest: verifier.verify threw', e);
    }
  }

  const sas = extractSasFromVerifier(v);
  if (sas.sasEmojis?.length || sas.sasDecimals?.length) {
    emitSnapshotForId(id, { phase: 'showing_sas', ...sas });
    emitSnapshotForId(rid, { phase: 'showing_sas', ...sas });
    if (txnId) emitSnapshotForId(txnId, { phase: 'showing_sas', ...sas });
    if (flowId) emitSnapshotForId(flowId, { phase: 'showing_sas', ...sas });
  } else {
    emitSnapshotForId(id, { phase: 'ready' });
    emitSnapshotForId(rid, { phase: 'ready' });
    if (txnId) emitSnapshotForId(txnId, { phase: 'ready' });
    if (flowId) emitSnapshotForId(flowId, { phase: 'ready' });
  }

  upsertVerificationReq(req);
  return true;
};

export const declineVerificationRequest = async (id: string) => {
  const req = resolveVerificationRequest(id);
  if (!req) {
    console.error('declineVerificationRequest: could not resolve request for id', id);
    return false;
  }

  const rid = getReqId(req);
  const verifier = req?.verifier || getVerifierForAnyId(id) || getVerifierForAnyId(rid);

  try {
    /* Signal a mismatch when the SAS screen is already showing rather than cancelling the request */
    if (verifier && typeof verifier.getShowSasCallbacks === 'function') {
      const cb = verifier.getShowSasCallbacks();
      if (cb?.mismatch) {
        cb.mismatch();
        upsertVerificationReq(req);
        refreshVerificationRequest(id);
        return true;
      }
    }

    if (typeof req.cancel === 'function') await req.cancel();
    else if (typeof req.reject === 'function') await req.reject();
    else if (typeof req.abort === 'function') await req.abort();
    else if (typeof req.cancelVerification === 'function') await req.cancelVerification();

    upsertVerificationReq(req);
    refreshVerificationRequest(id);
    return true;
  } catch (e) {
    console.error('declineVerificationRequest failed', e);
    try { upsertVerificationReq(req); } catch {}
    return false;
  }
};

export const cancelVerificationRequest = async (id: string) => {
  const req = resolveVerificationRequest(id);
  if (!req) {
    console.error('cancelVerificationRequest: could not resolve request for id', id);
    return false;
  }

  const rid = getReqId(req);
  const verifier = req?.verifier || getVerifierForAnyId(id) || getVerifierForAnyId(rid);

  try {
    if (verifier && typeof verifier.getShowSasCallbacks === 'function') {
      const cb = verifier.getShowSasCallbacks();
      if (cb?.cancel) {
        cb.cancel();
        upsertVerificationReq(req);
        refreshVerificationRequest(id);
        return true;
      }
    }

    if (typeof req.cancel === 'function') await req.cancel();
    else if (typeof req.abort === 'function') await req.abort();

    upsertVerificationReq(req);
    refreshVerificationRequest(id);
    return true;
  } catch (e) {
    console.error('cancelVerificationRequest failed', e);
    try { upsertVerificationReq(req); } catch {}
    return false;
  }
};

export const startEmojiVerification = confirmVerificationRequest;
export const isOutgoingVerificationRequest = (id: string): boolean => outgoingRequestIds.has(id);

export const requestVerificationToUser = async (userId: string, deviceIds?: string[]) => {
  const client = getMatrixClientOrThrow();
  const crypto = getCryptoModule(client);
  if (!crypto) throw new Error('Crypto is not initialised');

  const me = client.getUserId?.() || '';
  if (!me) throw new Error('User ID not available');

  /* Verifying your own other session uses a different SDK path than verifying another user */
  if (userId === me) {
    if (typeof crypto.requestOwnUserVerification === 'function') {
      const req = await crypto.requestOwnUserVerification();
      upsertVerificationReq(req);
      attachReqChangeListener(req);
      if (req?.verifier) attachVerifierListeners(getReqId(req), req, req.verifier);
      return snapshotFromReq(req);
    }
    throw new Error('Own-user verification is not supported by this crypto backend');
  }

  if (!deviceIds?.length) throw new Error('deviceIds are required to verify another user via to-device verification');

  if (typeof crypto.requestDeviceVerification !== 'function') {
    throw new Error('Device verification is not supported by this crypto backend');
  }

  const reqs = await Promise.all(deviceIds.map((d) => crypto.requestDeviceVerification(userId, d)));

  for (const req of reqs) {
    try {
      upsertVerificationReq(req);
      attachReqChangeListener(req);
      if (req?.verifier) attachVerifierListeners(getReqId(req), req, req.verifier);
    } catch {}
  }

  return snapshotFromReq(reqs[0]);
};

/* Starts an outgoing cross-signing verification with your other sessions, auto-starting SAS on accept */
export const requestVerificationForMyOtherSessions = async () => {
  const client = getMatrixClientOrThrow();
  const crypto = getCryptoModule(client);
  if (!crypto) throw new Error('Crypto is not initialised');

  if (typeof crypto.requestOwnUserVerification !== 'function') {
    throw new Error('Own-user verification is not supported by this crypto backend');
  }

  const req = await crypto.requestOwnUserVerification();
  const outgoingId = getReqId(req);
  const outgoingTxn = getTxnId(req);
  const outgoingFlow = getFlowId(req);

  outgoingRequestIds.add(outgoingId);
  if (outgoingTxn) outgoingRequestIds.add(outgoingTxn);
  if (outgoingFlow) outgoingRequestIds.add(outgoingFlow);

  upsertVerificationReq(req);
  attachReqChangeListener(req);

  let sasStarted = false;

  const startSasImmediately = async () => {
    if (sasStarted) return;
    sasStarted = true;

    const rid = getReqId(req);
    const txn = getTxnId(req);
    const flow = getFlowId(req);

    let v = req?.verifier;

    if (!v && typeof req?.startVerification === 'function') {
      try { v = await req.startVerification('m.sas.v1'); } catch {}
    }

    if (v) {
      attachVerifierListeners(rid, req, v);
      if (txn) attachVerifierListeners(txn, req, v);
      if (flow) attachVerifierListeners(flow, req, v);
      void v.verify?.().then(
        () => {
          try {
            upsertVerificationReq(req);
            refreshVerificationRequest(rid);
            if (txn) refreshVerificationRequest(txn);
            if (flow) refreshVerificationRequest(flow);
          } catch {}
        },
        () => { try { upsertVerificationReq(req); } catch {} }
      );
    }
  };

  /* Watch for m.key.verification.ready from the other session to start SAS automatically */
  const onToDevice = (ev: any) => {
    try {
      const type = typeof ev?.getType === 'function' ? String(ev.getType() || '') : String(ev?.type ?? '');
      if (type !== 'm.key.verification.ready') return;

      const content = typeof ev?.getContent === 'function' ? ev.getContent() : ev?.content;
      const evTxnId = String(content?.transaction_id ?? content?.transactionId ?? '') || '';

      if (evTxnId === outgoingTxn || evTxnId === outgoingId || evTxnId === outgoingFlow) {
        void startSasImmediately();
      }
    } catch {}
  };

  client.on(ClientEvent.ToDeviceEvent as any, onToDevice);

  const isReady = () => {
    if (req?.verifier) return true;
    const rawPhase = req?.phase ?? (typeof req?.getPhase === 'function' ? req.getPhase() : undefined);
    const p = String(rawPhase ?? '').toLowerCase();
    return p.includes('ready') || p.includes('accepted') || p.includes('started') || p.includes('start');
  };

  const handler = () => { if (isReady()) void startSasImmediately(); };

  try {
    if (typeof req?.on === 'function') {
      req.on('change', handler);
      req.on('changed', handler);
      req.on('update', handler);
    }
  } catch {}

  await waitForReqReadyOrVerifier(req, 30000);

  if (!sasStarted && isReady()) await startSasImmediately();

  try { client.removeListener(ClientEvent.ToDeviceEvent as any, onToDevice); } catch {}

  return snapshotFromReq(req);
};