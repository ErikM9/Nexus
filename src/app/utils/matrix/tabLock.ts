/* Two tabs running a client for one device would undo each other's crypto state, so only the tab with this lock runs one */

const LOCK_NAME = 'nexus-session';

/* How long a tab using the BroadcastChannel fallback waits for a running tab to answer before it assumes none is running */
const HANDSHAKE_MS = 250;

type ChannelMessage = { type: 'probe' | 'held' | 'steal'; from: string };

export interface TabLock {
  /* Takes the lock when it is free, or from the tab holding it when steal is set, and resolves to whether this tab holds it */
  claim(opts?: { steal?: boolean }): Promise<boolean>;
  /* Gives the lock up, as after signing out, so another tab can start a client without taking over */
  release(): void;
  /* Calls the listener when another tab takes the lock over from this one */
  onLost(listener: () => void): () => void;
}

export interface TabLockEnvironment {
  locks?: LockManager;
  openChannel?: () => BroadcastChannel;
}

/* Builds the lock on Web Locks, on a BroadcastChannel handshake without them, and grants every claim when neither exists */
export const createTabLock = ({ locks, openChannel }: TabLockEnvironment): TabLock => {
  const tabId = Math.random().toString(36).slice(2);
  const listeners = new Set<() => void>();
  let releaseHeld: (() => void) | null = null;
  let pending: Promise<boolean> | null = null;
  let channel: BroadcastChannel | null = null;

  const lose = () => {
    releaseHeld = null;
    listeners.forEach((listener) => listener());
  };

  const claimWithLocks = (lockManager: LockManager, steal: boolean) =>
    new Promise<boolean>((resolve) => {
      let holding = false;
      let release = () => {};
      lockManager
        .request(LOCK_NAME, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          holding = true;
          /* The lock stays held until this promise settles, which only release() does */
          return new Promise<void>((done) => {
            release = () => {
              holding = false;
              done();
            };
            releaseHeld = release;
            resolve(true);
          });
        })
        .catch(() => {
          /* A granted request rejects when another tab steals the lock, while a refused one lets this tab run unguarded */
          if (!holding) {
            resolve(true);
            return;
          }
          holding = false;
          if (releaseHeld === release) lose();
        });
    });

  const ensureChannel = (open: () => BroadcastChannel) => {
    if (channel) return channel;
    channel = open();
    channel.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (!message || message.from === tabId || !releaseHeld) return;
      if (message.type === 'probe') channel?.postMessage({ type: 'held', from: tabId } satisfies ChannelMessage);
      else if (message.type === 'steal') lose();
    });
    return channel;
  };

  const claimWithChannel = (open: () => BroadcastChannel, steal: boolean) =>
    new Promise<boolean>((resolve) => {
      const ch = ensureChannel(open);
      const take = () => {
        releaseHeld = () => {};
        resolve(true);
      };
      if (steal) {
        ch.postMessage({ type: 'steal', from: tabId } satisfies ChannelMessage);
        take();
        return;
      }
      const onReply = (event: MessageEvent<ChannelMessage>) => {
        if (event.data?.type === 'held' && event.data.from !== tabId) finish(false);
      };
      const finish = (free: boolean) => {
        clearTimeout(timer);
        ch.removeEventListener('message', onReply);
        if (free) take();
        else resolve(false);
      };
      const timer = setTimeout(() => finish(true), HANDSHAKE_MS);
      ch.addEventListener('message', onReply);
      ch.postMessage({ type: 'probe', from: tabId } satisfies ChannelMessage);
    });

  return {
    claim({ steal = false } = {}) {
      if (releaseHeld) return Promise.resolve(true);
      /* Start-up can ask twice before the first answer arrives, and a second request would find this tab's own lock taken */
      if (pending && !steal) return pending;
      const attempt = locks
        ? claimWithLocks(locks, steal)
        : openChannel
          ? claimWithChannel(openChannel, steal)
          : Promise.resolve(true);
      pending = attempt;
      const settle = () => {
        if (pending === attempt) pending = null;
      };
      attempt.then(settle, settle);
      return attempt;
    },

    release() {
      const release = releaseHeld;
      releaseHeld = null;
      release?.();
    },

    onLost(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

let shared: TabLock | null = null;

/* The lock for this tab, created on first use because navigator and BroadcastChannel only exist in the browser */
export const getTabLock = (): TabLock => {
  if (!shared) {
    /* Older browsers and some embedded views ship without Web Locks although the type says they always exist */
    const locks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
    const openChannel = typeof BroadcastChannel === 'undefined' ? undefined : () => new BroadcastChannel(LOCK_NAME);
    shared = createTabLock({ locks, openChannel });
  }
  return shared;
};