import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth');
  });

  test.describe('Login Page', () => {
    test('displays login form', async ({ page }) => {
      await expect(page.getByText('Sign in to Nexus')).toBeVisible();
      await expect(page.locator('input#username')).toBeVisible();
      await expect(page.locator('input#password')).toBeVisible();
      await expect(page.locator('button[type="submit"][form="login-form"]')).toBeVisible();
    });

    test('shows validation errors for empty fields', async ({ page }) => {
      await page.waitForLoadState('networkidle');

      /* requestSubmit triggers native HTML5 validation, which a pointer click would not */
      await page.locator('form#login-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(page.getByText(/enter a username and password/i)).toBeVisible({ timeout: 5000 });
    });

    test('shows error for invalid credentials', async ({ page }) => {
      await page.locator('input#username').fill('invaliduser');
      await page.locator('input#password').fill('wrongpassword');

      await page.locator('button[type="submit"][form="login-form"]').click();

      await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible({ timeout: 15000 });
    });

    test('redirects to chat on successful login', async ({ page }) => {
      await page.route('**/api/login', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            accessToken: 'test_access_token',
            userId: '@testuser:matrix.org',
            deviceId: 'TESTDEVICE',
            refreshToken: 'test_refresh_token',
          }),
        });
      });

      await page.locator('input#username').fill('testuser');
      await page.locator('input#password').fill('correctpassword');
      await page.locator('button[type="submit"][form="login-form"]').click();

      await expect(page).toHaveURL('/', { timeout: 10000 });
    });

    test('persists session in localStorage after login', async ({ page }) => {
      await page.route('**/api/login', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            accessToken: 'test_token',
            userId: '@testuser:matrix.org',
            deviceId: 'DEVICE123',
          }),
        });
      });

      await page.locator('input#username').fill('testuser');
      await page.locator('input#password').fill('password');
      await page.locator('button[type="submit"][form="login-form"]').click();

      await page.waitForURL('/');

      const accessToken = await page.evaluate(() => localStorage.getItem('mx_access_token'));
      const userId = await page.evaluate(() => localStorage.getItem('mx_user_id'));

      expect(accessToken).toBe('test_token');
      expect(userId).toBe('@testuser:matrix.org');
    });
  });

  test.describe('Registration Link', () => {
    test('shows link to Element registration', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
    });
  });

  test.describe('Session Restoration', () => {
    test('redirects to chat if session already exists in localStorage', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('mx_access_token', 'existing_token');
        localStorage.setItem('mx_user_id', '@user:matrix.org');
        localStorage.setItem('mx_session', JSON.stringify({
          accessToken: 'existing_token',
          userId: '@user:matrix.org',
          baseUrl: 'https://matrix.org',
        }));
        (window as any).__matrix_ready = true;
      });

      await page.goto('/');
      await expect(page).not.toHaveURL('/auth', { timeout: 5000 });
    });
  });
});

test.describe('Logout', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await page.route('**/api/logout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Logout' }).click();
  });

  test('logs out and redirects to auth', async ({ page }) => {
    await expect(page).toHaveURL('/auth', { timeout: 10000 });
  });

  test('clears localStorage on logout', async ({ page }) => {
    await page.waitForURL('/auth');
    const accessToken = await page.evaluate(() => localStorage.getItem('mx_access_token'));
    expect(accessToken).toBeNull();
  });
});