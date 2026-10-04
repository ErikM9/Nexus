import { test, expect } from './support/fixtures';

test.describe('When the homeserver is slow to answer', () => {
  test('shows a connecting screen, then a warning after twelve seconds', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.syncHoldMs = 60_000;
    hs.delay(/\/v3\/sync$/, 60_000);
    await page.clock.install();
    await nexus.seedSession();

    await page.goto('/');
    await expect(page.getByRole('status', { name: 'Loading' })).toContainText('Connecting to Matrix server…');

    await page.clock.runFor(12_500);
    await expect(page.getByText('Connection is taking longer than expected.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('Sign out on the warning ends the session and returns to sign in', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.syncHoldMs = 60_000;
    hs.delay(/\/v3\/sync$/, 60_000);
    await page.clock.install();
    await nexus.seedSession();
    await page.goto('/');
    await page.clock.runFor(12_500);

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/auth$/);
    expect(await nexus.stored('mx_session')).toBeNull();
    expect(await nexus.stored('mx_access_token')).toBeNull();
  });

  test('keeps the session when the first sync takes longer than fifteen seconds', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.delay(/\/v3\/sync$/, 5_000);
    await page.clock.install();
    await nexus.seedSession();
    await page.goto('/');
    await expect.poll(() => hs.requestsTo(/\/v3\/sync$/).length).toBeGreaterThan(0);

    await page.clock.runFor(20_000);

    await nexus.waitUntilReady();
    await expect(nexus.room('General')).toBeVisible();
    expect(await nexus.stored('mx_session')).not.toBeNull();
  });

  test('keeps the session while the homeserver is unreachable and connects on Retry once it is back', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.setReachable(false);
    await page.clock.install();
    await nexus.seedSession();
    await page.goto('/');
    await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
    await page.clock.runFor(12_500);
    await expect(page.getByText('Connection is taking longer than expected.')).toBeVisible();
    await expect(page.getByText("The homeserver can't be reached. Check your connection.")).toBeVisible();
    expect(await nexus.stored('mx_session')).not.toBeNull();

    hs.setReachable(true);
    await page.getByRole('button', { name: 'Retry' }).click();

    await nexus.waitUntilReady();
    await expect(nexus.room('General')).toBeVisible();
  });
});

test.describe('Start-up races', () => {
  test('keeps a healthy session signed in when the key-backup check is slow', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    test.setTimeout(40_000);
    hs.addRoom({ name: 'General' });
    /* The first sync completes while the slow backup check is still running, and the next one is held for 30 s */
    hs.syncHoldMs = 30_000;
    hs.delay(/room_keys\/version/, 1_500);
    await nexus.seedSession();

    await page.goto('/');

    await expect(page.getByText('Your chats')).toBeVisible({ timeout: 22_000 });
    await expect(page).not.toHaveURL(/\/auth$/);
  });
});

test.describe('Loading the encryption engine', () => {
  test('downloads the crypto WebAssembly once at start-up', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    const wasmDownloads: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('.wasm')) wasmDownloads.push(request.url());
    });

    await nexus.open();

    expect(wasmDownloads).toHaveLength(1);
  });
});