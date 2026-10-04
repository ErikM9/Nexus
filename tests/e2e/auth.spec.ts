import { test, expect } from './support/fixtures';
import { ACCESS_TOKEN, BOB, DEVICE_ID, ME, PASSWORD } from './support/homeserver';

const DEVICE_LEFT_BY_ALICE = DEVICE_ID;

test.describe('Signing in', () => {
  test.beforeEach(async ({ hs, page }) => {
    await hs.mockAppApi(page);
    await page.goto('/auth');
  });

  test('shows the sign-in form', async ({ nexus, page }) => {
    await expect(page.getByText('Sign in to Nexus')).toBeVisible();
    await expect(nexus.username).toBeVisible();
    await expect(nexus.username).toHaveAttribute('autocomplete', 'username');
    await expect(nexus.password).toHaveAttribute('type', 'password');
    await expect(nexus.signInButton).toHaveText('Sign in');
  });

  for (const [label, user, password] of [
    ['both fields empty', '', ''],
    ['no password', 'alice', ''],
    ['a blank username', '   ', PASSWORD],
  ]) {
    test(`asks for both fields before contacting the server, with ${label}`, async ({ nexus, hs, page }) => {
      await nexus.username.fill(user);
      await nexus.password.fill(password);
      await nexus.signInButton.click();

      await expect(page.getByText('Please enter a username and password')).toBeVisible();
      await expect(page).toHaveURL(/\/auth$/);
      expect(hs.requestsTo(/^\/api\/login$/)).toHaveLength(0);
    });
  }

  test('shows the error for a wrong password and stays on the form', async ({ nexus, page }) => {
    await nexus.signIn('alice', 'wrong password');

    await expect(page.getByText('Invalid username or password')).toBeVisible();
    await expect(page).toHaveURL(/\/auth$/);
    await expect(nexus.signInButton).toBeEnabled();
    await expect(nexus.password).toBeEnabled();
    expect(await nexus.stored('mx_session')).toBeNull();
  });

  test('signs in, stores the session and opens the chat list', { tag: '@smoke' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });

    await nexus.username.fill('  alice  ');
    await nexus.password.fill(PASSWORD);
    await nexus.password.press('Enter');

    await expect(page).toHaveURL(/\/$/);
    await nexus.waitUntilReady();
    await expect(nexus.room('General')).toBeVisible();

    const [login] = hs.requestsTo(/^\/api\/login$/);
    expect(login.body).toEqual({ user: 'alice', password: PASSWORD });

    expect(await nexus.stored('mx_session')).toMatchObject({ accessToken: ACCESS_TOKEN, userId: ME, deviceId: DEVICE_ID });
    expect(await nexus.stored('mx_user_id')).toBe(ME);
    expect(await nexus.stored('mx_device_id')).toBe(DEVICE_ID);
  });

  test('offers a device ID left in this browser back to the account it was issued to', async ({ nexus, hs, page }) => {
    await page.evaluate((me) => {
      localStorage.setItem('mx_device_id', 'EARLIERDEVICE');
      localStorage.setItem('mx_user_id', me);
    }, ME);

    await nexus.signIn('alice', PASSWORD);

    await nexus.waitUntilReady();
    expect(hs.requestsTo(/^\/api\/login$/)[0].body).toMatchObject({ deviceId: 'EARLIERDEVICE' });
  });

  test("never offers another account's device ID left in this browser", { tag: '@regression' }, async ({ nexus, hs, page }) => {
    await page.evaluate(({ me, deviceId }) => {
      localStorage.setItem('mx_device_id', deviceId);
      localStorage.setItem('mx_user_id', me);
    }, { me: ME, deviceId: DEVICE_LEFT_BY_ALICE });

    await nexus.signIn('bob', PASSWORD);

    await nexus.waitUntilReady();
    expect(hs.requestsTo(/^\/api\/login$/)[0].body).not.toHaveProperty('deviceId');
    expect(await nexus.stored('mx_session')).toMatchObject({ userId: BOB, deviceId: 'BOBDEVICE' });
  });

  test('Sign up explains registration and opens Element in a new tab', async ({ nexus, page }) => {
    await page.evaluate(() => {
      window.open = (...args: unknown[]) => {
        (window as unknown as { __opened: unknown[] }).__opened = args;
        return null;
      };
    });
    await nexus.username.fill('alice');
    await nexus.password.fill('half-typed');

    await page.getByRole('button', { name: 'Sign up' }).first().click();
    await expect(page.getByText('Create your Matrix account')).toBeVisible();
    await expect(page.getByText('How does this work?')).toBeVisible();
    await expect(nexus.username).toBeHidden();

    await page.getByRole('button', { name: 'Sign up' }).last().click();
    expect(await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual([
      'https://app.element.io/#/register',
      '_blank',
      'noopener,noreferrer',
    ]);

    await page.getByRole('button', { name: 'Sign in' }).last().click();
    await expect(page.getByText('Sign in to Nexus')).toBeVisible();
    await expect(nexus.username).toHaveValue('alice');
    await expect(nexus.password).toHaveValue('');
  });

  test('Create an account switches the form to sign up', async ({ page }) => {
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByText('Create your Matrix account')).toBeVisible();
    await expect(page.getByText('Already have an account?')).toBeVisible();
  });
});

test.describe('Signing in when the server is slow', () => {
  test('gives up after 15 seconds and says the request timed out', async ({ nexus, page }) => {
    await page.clock.install();
    await page.route('**/api/login', () => {});
    await page.goto('/auth');

    await nexus.signIn('alice', PASSWORD);
    await expect(nexus.signInButton).toBeDisabled();

    await page.clock.runFor(15_000);
    await expect(page.getByText('Request timed out. Please try again.')).toBeVisible();
    await expect(nexus.signInButton).toBeEnabled();
  });
});

test.describe('Stored sessions', () => {
  test('a stored session skips the sign-in page', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.seedSession();

    await page.goto('/auth');

    await expect(page).toHaveURL(/\/$/);
    await nexus.waitUntilReady();
    await expect(nexus.room('General')).toBeVisible();
  });

  test('without a session the chat page sends you to sign in', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByText('Sign in to Nexus')).toBeVisible();
  });

  test('shows a connecting screen until the first sync arrives', async ({ nexus, hs, page }) => {
    hs.delay(/\/v3\/sync$/, 1500);
    await nexus.seedSession();

    await page.goto('/');

    await expect(page.getByRole('status', { name: 'Loading' })).toContainText('Connecting to Matrix server…');
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    await nexus.waitUntilReady();
    await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0);
  });

  test('a session the server rejects on start-up ends on the sign-in page', async ({ nexus, hs, page }) => {
    hs.revokeAccessToken();
    await nexus.seedSession();

    await page.goto('/');

    await expect(page).toHaveURL(/\/auth$/, { timeout: 20_000 });
    expect(await nexus.stored('mx_session')).toBeNull();
    expect(await nexus.stored('mx_access_token')).toBeNull();
  });

  test('a session revoked while chatting returns to the sign-in page', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    hs.revokeAccessToken();

    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByText('Sign in to Nexus')).toBeVisible();
    expect(await nexus.stored('mx_session')).toBeNull();
  });
});

test.describe('Refreshing the access token', () => {
  test('keeps syncing across token refreshes when the server does not rotate the refresh token', { tag: '@regression' }, async ({ nexus, hs }) => {
    const refreshToken = hs.enableRefreshTokens({ accessTokenLifetimeMs: 2_000, rotateRefreshTokens: false });
    const roomId = hs.addRoom({ name: 'General' });
    await nexus.seedSession({ refreshToken });
    await nexus.page.goto('/');
    await nexus.waitUntilReady();
    await nexus.openRoom('General');

    await expect.poll(() => hs.requestsTo(/\/v3\/refresh$/).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    hs.say(roomId, BOB, 'Still connected after three refreshes');

    await expect(nexus.message('Still connected after three refreshes')).toBeVisible();
  });

  test('keeps syncing across rotated refresh tokens and stores the latest pair', async ({ nexus, hs }) => {
    const refreshToken = hs.enableRefreshTokens({ accessTokenLifetimeMs: 2_000, rotateRefreshTokens: true });
    const roomId = hs.addRoom({ name: 'General' });
    await nexus.seedSession({ refreshToken });
    await nexus.page.goto('/');
    await nexus.waitUntilReady();
    await nexus.openRoom('General');

    await expect.poll(() => hs.requestsTo(/\/v3\/refresh$/).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    hs.say(roomId, BOB, 'Still connected after rotating tokens');

    await expect(nexus.message('Still connected after rotating tokens')).toBeVisible();
    const stored = (await nexus.stored('mx_session')) as { accessToken: string; refreshToken: string };
    expect(hs.acceptsAccessToken(stored.accessToken)).toBe(true);
    expect(stored.refreshToken).not.toBe(refreshToken);
  });

  test('returns to sign in when the server rejects the refresh token', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const refreshToken = hs.enableRefreshTokens({ accessTokenLifetimeMs: 60 * 60_000 });
    hs.addRoom({ name: 'General' });
    await nexus.seedSession({ refreshToken });
    await page.goto('/');
    await nexus.waitUntilReady();

    hs.revokeAccessToken();

    await expect(page).toHaveURL(/\/auth$/, { timeout: 20_000 });
    expect(hs.requestsTo(/\/v3\/refresh$/).length).toBeGreaterThan(0);
    expect(await nexus.stored('mx_session')).toBeNull();
  });
});

test.describe('Logging out', () => {
  test('Logout ends the session on the server and returns to sign in', { tag: ['@regression', '@smoke'] }, async ({ nexus, hs, page }) => {
    await nexus.open();

    await page.getByRole('button', { name: 'Logout' }).click();

    await expect(page.getByText('Logged out')).toBeVisible();
    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByRole('button', { name: 'Logout' })).toHaveCount(0);
    expect(hs.requestsTo(/\/v3\/logout$/, 'POST')).toHaveLength(1);
    expect(hs.acceptsAccessToken(ACCESS_TOKEN)).toBe(false);
  });

  test('after logging out the chat page asks for sign in again', async ({ nexus, page }) => {
    await nexus.open();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth$/);

    await page.goto('/');
    await expect(page).toHaveURL(/\/auth$/);
  });

  test('signing back in after logging out registers a new device', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    await hs.mockAppApi(page);
    await nexus.open();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth$/);

    await nexus.signIn('alice', PASSWORD);

    await nexus.waitUntilReady();
    expect(hs.requestsTo(/^\/api\/login$/)[0].body).not.toHaveProperty('deviceId');
  });
});

test.describe('Switching accounts', () => {
  test('signs in a second account after the first one signed out', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    await hs.mockAppApi(page);
    await nexus.open();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth$/);

    await nexus.signIn('bob', PASSWORD);

    await nexus.waitUntilReady();
    await expect(page).not.toHaveURL(/\/auth$/);
    expect(await nexus.stored('mx_session')).toMatchObject({ userId: BOB, deviceId: 'BOBDEVICE' });
  });

  test("starts with a fresh crypto store when the saved one can't be opened with this browser's key", { tag: '@regression' }, async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    /* A store written under a key this browser no longer has is what another account's store looks like to this one */
    await page.evaluate((me) => localStorage.removeItem(`mx_rust_crypto_key_${me}`), ME);

    await page.reload();

    await nexus.waitUntilReady();
    await expect(nexus.room('General')).toBeVisible();
    expect(await nexus.stored('mx_session')).toMatchObject({ userId: ME, cryptoStorePrefix: expect.stringMatching(/^nexus-/) });
  });
});