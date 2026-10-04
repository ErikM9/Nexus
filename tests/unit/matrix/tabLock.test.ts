import { describe, it, expect, vi, afterEach } from 'vitest';
import { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads';
import { createTabLock, type TabLock } from '@/app/utils/matrix/tabLock';

/* Models the two Web Locks behaviours the guard relies on: ifAvailable is answered with null while the lock is held, and steal rejects the holder's request with an AbortError */
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

  it('runs unguarded when the browser refuses the lock request', async () => {
    const locks = { request: () => Promise.reject(new DOMException('Access denied', 'SecurityError')) } as unknown as LockManager;

    expect(await createTabLock({ locks }).claim()).toBe(true);
  });
});

describe('tab lock with the BroadcastChannel fallback', () => {
  it('turns a second tab away when the running tab answers its handshake', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });

    expect(await first.claim()).toBe(true);
    expect(await second.claim()).toBe(false);
  });

  it('hands the session to a tab that takes over and tells the previous holder', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });
    const firstLost = lostSpy(first);
    await first.claim();

    expect(await second.claim({ steal: true })).toBe(true);

    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledTimes(1));
    expect(await first.claim()).toBe(false);
  });

  it('starts once nobody answers, as after the running tab signed out', async () => {
    const first = createTabLock({ openChannel });
    const second = createTabLock({ openChannel });
    await first.claim();

    first.release();

    expect(await second.claim()).toBe(true);
  });
});

describe('tab lock without either browser API', () => {
  it('lets every tab run, since there is nothing to coordinate with', async () => {
    expect(await createTabLock({}).claim()).toBe(true);
    expect(await createTabLock({}).claim()).toBe(true);
  });
});