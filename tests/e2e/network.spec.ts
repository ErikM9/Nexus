import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Network Handling', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Offline Detection', () => {
    test('app loads and displays UI when online', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });
    });

    test('handles offline state gracefully', async ({ page, context }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('NEXUS')).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByText('NEXUS')).toBeVisible();
      await context.setOffline(false);
    });

    test('maintains UI interactivity after brief offline period', async ({ page, context }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();
      await page.keyboard.press('Escape');
      await context.setOffline(true);
      await page.waitForTimeout(1000);
      await context.setOffline(false);
      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();
    });
  });

  test.describe('Failed Request Handling', () => {
    test('renders main UI even when Matrix API is unreachable', async ({ page }) => {
      await page.route('**/_matrix/**', route => route.abort('connectionfailed'));
      await page.goto('/');
      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });
    });
  });

  test.describe('Connection State Display', () => {
    test('hides authenticated actions when matrix-ready flag is absent', async ({ page }) => {
      await page.addInitScript(() => {
        window.__matrix_ready = undefined;
      });

      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-testid="settings-button"]')).not.toBeVisible();
    });

    test('shows/hides settings button as matrix-ready state changes', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.evaluate(() => {
        (window as any).__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
      });

      await expect(page.getByTestId('settings-button')).not.toBeVisible();

      await page.evaluate(() => {
        (window as any).__matrix_ready = true;
        window.dispatchEvent(new Event('matrix-ready'));
      });

      await expect(page.getByTestId('settings-button')).toBeVisible();
    });
  });

  test.describe('Error Messages', () => {
    test('does not expose raw JS error strings in the page', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const pageContent = await page.textContent('body');

      for (const pattern of [
        'undefined is not',
        'Cannot read property',
        'NetworkError',
        'TypeError',
        'SyntaxError',
      ]) {
        expect(pageContent).not.toContain(pattern);
      }
    });
  });

  test.describe('Auth Page Network Handling', () => {
    test('auth page loads without a Matrix connection', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/_matrix/**', route => route.abort());
      await page.goto('/auth');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('input:not([disabled])').first()).toBeVisible({ timeout: 15000 });
      await context.close();
    });

    test('page stays functional after a failed login attempt', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route('**/_matrix/**', route => route.fulfill({
        status: 500,
        body: JSON.stringify({ error: 'Server error' }),
      }));

      await page.goto('/auth');
      await page.waitForLoadState('networkidle');

      const inputs = page.locator('input:not([disabled])');
      if (await inputs.count() >= 2) {
        await inputs.nth(0).fill('testuser');
        await inputs.nth(1).fill('testpassword');

        const submitBtn = page.locator('button[type="submit"]');
        if (await submitBtn.isVisible()) {
          await submitBtn.click();

          await expect(page.locator('input').first()).toBeVisible({ timeout: 5000 });
        }
      }

      await context.close();
    });
  });

  test.describe('Request Timeout Handling', () => {
    test('UI remains interactive when Matrix API is unresponsive', async ({ page }) => {
      await page.route('**/_matrix/**', () => new Promise(() => {}));

      await page.goto('/');

      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });

      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();
    });
  });

  test.describe('Retry Behavior', () => {
    test('app remains functional after network recovery', async ({ page, context }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('NEXUS')).toBeVisible();
      await context.setOffline(true);
      await page.waitForTimeout(500);
      await context.setOffline(false);
      await page.waitForTimeout(500);
      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();
    });
  });

  test.describe('Local Storage Persistence', () => {
    test('theme preference survives an offline reload cycle', async ({ page, context }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await context.setOffline(true);
      try {
        await page.reload({ timeout: 5000 });
      } catch {
      }

      await context.setOffline(false);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('session persists in localStorage across reloads', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const session = await page.evaluate(() => localStorage.getItem('mx_session'));
      expect(session).toBeTruthy();

      await page.reload();
      await page.waitForLoadState('networkidle');

      const sessionAfterReload = await page.evaluate(() => localStorage.getItem('mx_session'));
      expect(sessionAfterReload).toBeTruthy();
    });
  });

  test.describe('Loading States', () => {
    test('shows NEXUS header while Matrix API loads', async ({ page }) => {
      await page.route('**/_matrix/**', async route => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        route.continue();
      });

      await page.goto('/');
      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });
    });
  });
});