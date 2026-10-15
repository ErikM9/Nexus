import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads';
import { createTabLock, type TabLock } from '@/app/utils/matrix/tabLock';

/* Models the Web Locks the guard relies on, where ifAvailable gets null while the lock is held and steal aborts the holder */
class FakeLockManager {
  private holder: { reject: (reason: unknown) => void } | null = null;

  /* The callback is typed out rather than named, as newer TypeScript makes LockGrantedCallback generic */
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      queueMicrotask(async () => {
        if (this.holder && options.ifAvailable) {
          resolve(await callback(null));
          return;
        }
        if (this.holder && options.steal) {
          this.holder.reject(new DOMException("Lock broken by another request with the 'steal' option.", 'AbortError'));
          this.holder = null;
        }
        const me = { reject };
        this.holder = me;
        const result = await callback({ name, mode: 'exclusive' } as Lock);
        if (this.holder === me) this.holder = null;
        resolve(result);
      });
    });
  }
}

const channels: NodeBroadcastChannel[] = [];

/* Node's BroadcastChannel delivers between instances in one process, the way the browser's does between tabs */
const openChannel = () => {
  const channel = new NodeBroadcastChannel('nexus-session-test');
  channels.push(channel);
  return channel as unknown as BroadcastChannel;
};

const lostSpy = (lock: TabLock) => {
  const onLost = vi.fn();
  lock.onLost(onLost);
  return onLost;
};

afterEach(() => {
  vi.useRealTimers();
  channels.splice(0).forEach((channel) => channel.close());
});

describe('tab lock with Web Locks', () => {
  const twoTabs = () => {
    const locks = new FakeLockManager() as unknown as LockManager;
    return [createTabLock({ locks }), createTabLock({ locks })] as const;
  };

  it('lets the first tab run and turns a second tab away', async () => {
    const [first, second] = twoTabs();

    expect(await first.claim()).toBe(true);
    expect(await second.claim()).toBe(false);
  });

  it('hands the lock to a tab that takes over and tells the previous holder', async () => {
    const [first, second] = twoTabs();
    const firstLost = lostSpy(first);
    await first.claim();

    expect(await second.claim({ steal: true })).toBe(true);

    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledTimes(1));
    expect(await first.claim()).toBe(false);
  });

  it('lets another tab start without taking over once the holder released the lock', async () => {
    const [first, second] = twoTabs();
    const firstLost = lostSpy(first);
    await first.claim();

    first.release();

    expect(await second.claim()).toBe(true);
    expect(firstLost).not.toHaveBeenCalled();
  });

  it('answers a tab that asks twice during start-up with the same grant', async () => {
    const [first] = twoTabs();

    await expect(Promise.all([first.claim(), first.claim()])).resolves.toEqual([true, true]);
  });

  it('keeps granting the lock to the tab that holds it', async () => {
    const [first] = twoTabs();
    await first.claim();

    expect(await first.claim()).toBe(true);
  });

  it('lets only one of two tabs that start together run when BroadcastChannel is also available', async () => {
    const locks = new FakeLockManager() as unknown as LockManager;
    const first = createTabLock({ locks, openChannel });
    const second = createTabLock({ locks, openChannel });

    const claims = await Promise.all([first.claim(), second.claim()]);

    expect(claims).toEqual([true, false]);
  });

  it('runs unguarded when the browser refuses the lock request', async () => {
    const locks = { request: () => Promise.reject(new DOMException('Access denied', 'SecurityError')) } as unknown as LockManager;

    expect(await createTabLock({ locks }).claim()).toBe(true);
  });
});

describe('tab lock with the BroadcastChannel fallback', () => {
  /* The handshake timer is faked while messages still travel between the channels, so only a real answer turns a tab away */
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /* Claims the lock for a tab with nobody to answer it, which takes the whole handshake window */
  const claimAlone = async (lock: TabLock) => {
    const claiming = lock.claim();
    await vi.advanceTimersByTimeAsync(250);
    return claiming;
  };

  /* Resolves once a channel has received its next message, by which time the lock's own listener on it has run */
  const nextMessage = (channel: NodeBroadcastChannel) =>
    new Promise<void>((resolve) => channel.addEventListener('message', () => resolve(), { once: true }));

  it('waits a quarter of a second for a running tab to answer before starting', async () => {
    const settled = vi.fn();
    void createTabLock({ openChannel }).claim().then(settled);

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(true);
  });

  it('turns a second tab away when the running tab answers its handshake', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });

    expect(await claimAlone(first)).toBe(true);
    expect(await second.claim()).toBe(false);
  });

  it('keeps a turned-away tab away once its handshake window has passed', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });
    await claimAlone(first);
    await second.claim();

    await vi.advanceTimersByTimeAsync(250);

    expect(await second.claim()).toBe(false);
  });

  it('hands the session to a tab that takes over and tells the previous holder', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });
    const firstLost = lostSpy(first);
    await claimAlone(first);

    expect(await second.claim({ steal: true })).toBe(true);

    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledTimes(1));
    expect(await first.claim()).toBe(false);
  });

  it('starts once nobody answers, as after the running tab signed out', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });
    await claimAlone(first);
    first.release();
    const firstAnswers = vi.spyOn(channels[0], 'postMessage');
    const probed = nextMessage(channels[0]);

    const claiming = second.claim();
    await probed;
    await vi.advanceTimersByTimeAsync(250);

    expect(firstAnswers).not.toHaveBeenCalled();
    expect(await claiming).toBe(true);
  });
});

describe('getTabLock', () => {
  /* Loads the module again, so this tab's lock is built for the browser the test has just set up */
  const freshTabLock = async () => {
    vi.resetModules();
    const { getTabLock } = await import('@/app/utils/matrix/tabLock');
    return getTabLock();
  };

  afterEach(() => {
    delete (navigator as { locks?: LockManager }).locks;
  });

  it('builds the lock on Web Locks when the browser has them', async () => {
    const locks = new FakeLockManager() as unknown as LockManager;
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    await createTabLock({ locks }).claim();

    const lock = await freshTabLock();

    expect(await lock.claim()).toBe(false);
  });

  it('falls back to the BroadcastChannel handshake in a browser without Web Locks', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    void (await freshTabLock()).claim().then(settled);

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(true);
  });
});

describe('tab lock without either browser API', () => {
  it('lets every tab run, since there is nothing to coordinate with', async () => {
    expect(await createTabLock({}).claim()).toBe(true);
    expect(await createTabLock({}).claim()).toBe(true);
  });
});