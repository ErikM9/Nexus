import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { NexusPage } from './support/nexus-page';
import { ACCESS_TOKEN, BOB, ME, type FakeHomeserver } from './support/homeserver';

const SSK_KEY = 'mx_ssk_private_key_b64';
/* A well-formed recovery key (the SDK's encoding of 32 bytes of 7) that belongs to no account in these tests */
const UNRELATED_RECOVERY_KEY = 'EsT3 4kza y1Xs efFA tKyi HVwT kdEP 4UEk rvNr dFvy 8nGq AkqP';
const OTHER_DEVICE = 'PHONEDEVICE';

/* The to-device request another of the user's devices sends to start verifying this one */
const verificationRequestFrom = (deviceId: string, transactionId: string) => ({
  from_device: deviceId,
  methods: ['m.sas.v1'],
  timestamp: Date.now(),
  transaction_id: transactionId,
});

test.describe('Settings menu', () => {
  test('offers the four session actions and closes with Escape', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();

    const menu = await nexus.openSettingsMenu();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Get Recovery Key',
      'Use Recovery Key',
      'Verify this session',
      'Forget this session',
    ]);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

test.describe('Recovery key', () => {
  test('creates a recovery key and shows it with a copy button', { tag: '@smoke' }, async ({ nexus, hs, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();

    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');
    await panel.getByRole('button', { name: 'Create' }).click();

    const key = panel.getByRole('status', { name: 'Your Recovery Key' });
    await expect(key).toBeVisible({ timeout: 15_000 });
    await expect(key).not.toBeEmpty();
    expect(hs.currentKeyBackup()).not.toBeNull();

    await panel.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Recovery Key copied')).toBeVisible();
    expect((await page.evaluate(() => navigator.clipboard.readText())).length).toBeGreaterThan(10);
  });

  test('asks for a key before trying to restore', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();

    const panel = await nexus.openSessionPanel('Use Recovery Key', 'Use Recovery Key');
    await panel.getByRole('button', { name: 'Recover' }).click();

    await expect(page.getByText('Please enter your Recovery Key.')).toBeVisible();
    expect(hs.requestsTo(/room_keys\/keys/)).toHaveLength(0);
  });

  test('asks before replacing a key backup this device cannot read', { tag: '@regression' }, async ({ nexus, hs }) => {
    const existing = hs.addKeyBackup();
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');

    await panel.getByRole('button', { name: 'Create' }).click();

    await expect(panel.getByRole('alert')).toContainText("already has a key backup this device can't read");
    await expect(panel.getByRole('button', { name: 'Delete backup and create key' })).toBeVisible();
    await expect(panel.getByRole('status', { name: 'Your Recovery Key' })).toHaveCount(0);
    expect(hs.requestsTo(/room_keys\/version\//, 'DELETE')).toHaveLength(0);
    expect(hs.currentKeyBackup()).toMatchObject({ version: existing });
  });

  test('replaces a backup this device cannot read once the user confirms', { tag: '@regression' }, async ({ nexus, hs }) => {
    const existing = hs.addKeyBackup();
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');
    await panel.getByRole('button', { name: 'Create' }).click();

    await panel.getByRole('button', { name: 'Delete backup and create key' }).click();

    await expect(panel.getByRole('status', { name: 'Your Recovery Key' })).toBeVisible({ timeout: 15_000 });
    expect(hs.requestsTo(new RegExp(`room_keys/version/${existing}$`), 'DELETE')).toHaveLength(1);
    expect(hs.currentKeyBackup()).not.toMatchObject({ version: existing });
  });

  test('New key keeps the backup this device can read', { tag: '@regression' }, async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');
    await panel.getByRole('button', { name: 'Create' }).click();
    const key = panel.getByRole('status', { name: 'Your Recovery Key' });
    await expect(key).toBeVisible({ timeout: 15_000 });
    const firstKey = (await key.textContent()) ?? '';
    const backup = hs.currentKeyBackup();

    await panel.getByRole('button', { name: 'Generate new key' }).click();

    await expect(key).not.toHaveText(firstKey, { timeout: 15_000 });
    expect(hs.requestsTo(/room_keys\/version\//, 'DELETE')).toHaveLength(0);
    expect(hs.currentKeyBackup()).toMatchObject({ version: backup?.version });
  });

  test('keeps the saved recovery key when creating a new one fails', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await page.evaluate((k) => localStorage.setItem(k, 'c2F2ZWQtcmVjb3Zlcnkta2V5LXRoaXJ0eS10d28tYnk='), SSK_KEY);
    hs.failNext(/\/account_data\/m\.secret_storage\.key\./, 500, { errcode: 'M_UNKNOWN', error: 'Internal error' }, { method: 'PUT' });
    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');

    await panel.getByRole('button', { name: 'Create' }).click();

    await expect(panel.getByText("Couldn't create a Recovery Key. Check your connection and try again.")).toBeVisible({ timeout: 15_000 });
    expect(await nexus.stored(SSK_KEY)).toBe('c2F2ZWQtcmVjb3Zlcnkta2V5LXRoaXJ0eS10d28tYnk=');
  });
});

test.describe('Restoring with a recovery key', () => {
  /* Creates secret storage and a key backup through the app, returning the recovery key it showed */
  const createRecoveryKey = async (nexus: NexusPage): Promise<string> => {
    const panel = await nexus.openSessionPanel('Get Recovery Key', 'Get Recovery Key');
    await panel.getByRole('button', { name: 'Create' }).click();
    const key = panel.getByRole('status', { name: 'Your Recovery Key' });
    await expect(key).toBeVisible({ timeout: 15_000 });
    const text = (await key.textContent()) ?? '';
    await panel.getByRole('button', { name: 'Close' }).click();
    return text.trim();
  };

  const restoreWith = async (nexus: NexusPage, recoveryKey: string) => {
    const panel = await nexus.openSessionPanel('Use Recovery Key', 'Use Recovery Key');
    await panel.getByLabel('Recovery Key').fill(recoveryKey);
    await panel.getByRole('button', { name: 'Recover' }).click();
    return panel;
  };

  test('restores with the right key and reports what was restored', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const recoveryKey = await createRecoveryKey(nexus);

    const panel = await restoreWith(nexus, recoveryKey);

    await expect(nexus.page.getByText('Recovery Successful')).toBeVisible({ timeout: 15_000 });
    await expect(nexus.page.getByText("Your Recovery Key is correct. Your key backup doesn't hold any message keys yet.")).toBeVisible();
    await expect(panel).toHaveCount(0);
  });

  test('says the key is right but there is no backup when the server has none', { tag: '@regression' }, async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const recoveryKey = await createRecoveryKey(nexus);
    hs.removeKeyBackup();

    const panel = await restoreWith(nexus, recoveryKey);

    await expect(panel.getByText('Your Recovery Key is correct, but there is no key backup on the server to restore from.')).toBeVisible({ timeout: 15_000 });
  });

  test('reports a server failure during the restore as a server problem', { tag: '@regression' }, async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    const recoveryKey = await createRecoveryKey(nexus);
    hs.failNext(/\/room_keys\/keys/, 502, { errcode: 'M_UNKNOWN', error: 'Bad gateway' }, { method: 'GET' });

    const panel = await restoreWith(nexus, recoveryKey);

    await expect(panel.getByText("The homeserver couldn't complete the restore (error 502). Try again later.")).toBeVisible({ timeout: 15_000 });
  });

  test('does not keep a key it could not check against the account', { tag: '@regression' }, async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();

    const panel = await restoreWith(nexus, UNRELATED_RECOVERY_KEY);

    await expect(panel.getByText("Your account doesn't have a Recovery Key yet. Use Get Recovery Key to set one up.")).toBeVisible();
    expect(await nexus.stored(SSK_KEY)).toBeNull();
  });

  test("says the key is wrong instead of restoring, and keeps the account's own key cached", { tag: '@regression' }, async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await createRecoveryKey(nexus);
    const storedBefore = await nexus.stored(SSK_KEY);

    const panel = await restoreWith(nexus, UNRELATED_RECOVERY_KEY);

    await expect(panel.getByText("This Recovery Key doesn't belong to your account. Check it and try again.")).toBeVisible({ timeout: 15_000 });
    expect(await nexus.stored(SSK_KEY)).toBe(storedBefore);
  });
});

test.describe('Verifying this session', () => {
  test('opens the verification panel ready to start', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();

    const panel = await nexus.openSessionPanel('Verify this session', 'Verification');
    await expect(panel.getByText('Start a verification request, then compare the emoji code.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Start Verification' })).toBeEnabled();

    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
  });

  test('shows a request from your other device and drops it when that device cancels', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    hs.addOwnDevice(OTHER_DEVICE);
    await nexus.open();
    hs.sendToDevice(ME, 'm.key.verification.request', verificationRequestFrom(OTHER_DEVICE, 'txn-cancelled'));
    await expect(page.getByText('Verification requested')).toBeVisible();

    hs.sendToDevice(ME, 'm.key.verification.cancel', { transaction_id: 'txn-cancelled', code: 'm.user', reason: 'Cancelled on the phone' });

    await expect(page.getByText('Verification requested')).toHaveCount(0);
  });

  test('closes an open request that the other device cancels and says so', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    hs.addOwnDevice(OTHER_DEVICE);
    await nexus.open();
    hs.sendToDevice(ME, 'm.key.verification.request', verificationRequestFrom(OTHER_DEVICE, 'txn-open'));
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('Incoming verification request')).toBeVisible();

    hs.sendToDevice(ME, 'm.key.verification.cancel', { transaction_id: 'txn-open', code: 'm.user', reason: 'Cancelled on the phone' });

    await expect(page.getByText('Incoming verification request')).toHaveCount(0);
    await expect(page.getByText('Verification cancelled')).toBeVisible();
  });

  test('shows a request that arrived while the app was still starting', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    hs.addOwnDevice(OTHER_DEVICE);
    await nexus.open();
    /* Leaving and coming back keeps the crypto store that knows the other device, and the request lands in the first sync */
    await page.goto('about:blank');
    hs.sendToDevice(ME, 'm.key.verification.request', verificationRequestFrom(OTHER_DEVICE, 'txn-early'));

    await page.goto('/');

    await nexus.waitUntilReady();
    await expect(page.getByText('Verification requested')).toBeVisible();
    await expect(page.getByText(OTHER_DEVICE)).toBeVisible();
  });
});

test.describe('Forgetting this session', () => {
  test('warns, then ends the session on the server and wipes every account from this browser', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await page.evaluate((key) => localStorage.setItem(key, 'a2V5LWxlZnQtYnktYW5vdGhlci1hY2NvdW50'), `mx_rust_crypto_key_${BOB}`);

    const panel = await nexus.openSessionPanel('Forget this session', 'Forget this session?');
    await expect(panel).toContainText('remove all local encryption keys');
    await panel.getByRole('button', { name: 'Forget session' }).click();

    await expect(page.getByText('Session forgotten')).toBeVisible();
    await expect(page).toHaveURL(/\/auth$/);
    expect(hs.acceptsAccessToken(ACCESS_TOKEN)).toBe(false);
    expect((await nexus.storedKeys()).filter((key) => key.startsWith('mx'))).toEqual([]);
    await expect.poll(() => nexus.databaseNames()).not.toContainEqual(expect.stringContaining('matrix-sdk-crypto'));
  });
});

test.describe('Signing out', () => {
  test('leaves no recovery key, token, device ID or crypto store of the account behind', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await page.evaluate((k) => localStorage.setItem(k, 'cGxhaW4tcmVjb3Zlcnkta2V5'), SSK_KEY);
    expect(await nexus.databaseNames()).toContainEqual(expect.stringContaining('matrix-sdk-crypto'));

    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth$/);

    for (const key of [SSK_KEY, `mx_rust_crypto_key_${ME}`, 'mx_session', 'mx_access_token', 'mx_refresh_token', 'mx_user_id', 'mx_device_id']) {
      expect(await nexus.stored(key), key).toBeNull();
    }
    await expect.poll(() => nexus.databaseNames()).not.toContainEqual(expect.stringContaining('matrix-sdk-crypto'));
  });
});

test.describe('Using Nexus in more than one tab', () => {
  const OTHER_TAB = 'Nexus is open in another tab';

  /* A second tab of the same browser, which shares the first tab's stored session and talks to the same fake homeserver */
  const openSecondTab = async (nexus: NexusPage, hs: FakeHomeserver, baseURL: string | undefined) => {
    const page = await nexus.page.context().newPage();
    await hs.install(page, new URL(baseURL ?? 'http://localhost:3000').origin);
    return new NexusPage(page, hs);
  };

  /* Counts the sync requests a tab starts from now on, which is how a running client shows itself to the server */
  const countSyncs = (page: Page) => {
    let syncs = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/sync')) syncs++;
    });
    return () => syncs;
  };

  const takeOverScenario = async (nexus: NexusPage, hs: FakeHomeserver, baseURL: string | undefined) => {
    const roomId = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();
    const second = await openSecondTab(nexus, hs, baseURL);
    const secondSyncs = countSyncs(second.page);

    await second.page.goto('/');

    await expect(second.page.getByRole('heading', { name: OTHER_TAB })).toBeVisible();
    expect(secondSyncs(), 'syncs from the tab that found the session in use').toBe(0);

    await second.page.getByRole('button', { name: 'Use Nexus here' }).click();

    await second.waitUntilReady();
    await expect(nexus.page.getByRole('heading', { name: OTHER_TAB })).toBeVisible();

    const firstSyncs = countSyncs(nexus.page);
    hs.say(roomId, BOB, 'Only one tab is listening');
    await second.openRoom('General');
    await expect(second.message('Only one tab is listening')).toBeVisible();
    expect(firstSyncs(), 'syncs from the tab that was taken over').toBe(0);
  };

  test('runs the session in one tab and lets another tab take it over', { tag: '@regression' }, async ({ nexus, hs, baseURL }) => {
    await takeOverScenario(nexus, hs, baseURL);
  });

  test('coordinates tabs over a BroadcastChannel when the browser has no Web Locks', { tag: '@regression' }, async ({ nexus, hs, baseURL }) => {
    await nexus.page.context().addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });
    });

    await takeOverScenario(nexus, hs, baseURL);
  });

  test('lets the tab that was taken over take the session back', async ({ nexus, hs, baseURL }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    const second = await openSecondTab(nexus, hs, baseURL);
    await second.page.goto('/');
    await second.page.getByRole('button', { name: 'Use Nexus here' }).click();
    await second.waitUntilReady();

    await nexus.page.getByRole('button', { name: 'Use Nexus here' }).click();

    await nexus.waitUntilReady();
    await expect(second.page.getByRole('heading', { name: OTHER_TAB })).toBeVisible();
  });

  test('sends a waiting tab to sign in when the running tab signed out meanwhile', async ({ nexus, hs, baseURL }) => {
    await nexus.open();
    const second = await openSecondTab(nexus, hs, baseURL);
    await second.page.goto('/');
    await expect(second.page.getByRole('heading', { name: OTHER_TAB })).toBeVisible();

    await nexus.page.getByRole('button', { name: 'Logout' }).click();
    await expect(nexus.page).toHaveURL(/\/auth$/);
    await second.page.getByRole('button', { name: 'Use Nexus here' }).click();

    await expect(second.page).toHaveURL(/\/auth$/);
  });
});