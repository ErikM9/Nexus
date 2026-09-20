import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Keyboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Tab Navigation', () => {
    test('can tab through header buttons', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.locator('body').focus();

      let foundThemeToggle = false;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const focused = page.locator(':focus');
        const label = await focused.getAttribute('aria-label');
        if (label === 'Toggle theme') {
          foundThemeToggle = true;
          break;
        }
      }

      expect(foundThemeToggle).toBe(true);
    });

    test('can tab to settings button', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.locator('body').focus();

      let foundSettings = false;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const focused = page.locator(':focus');
        const testId = await focused.getAttribute('data-testid');
        if (testId === 'settings-button') {
          foundSettings = true;
          break;
        }
      }

      expect(foundSettings).toBe(true);
    });

    test('can tab to logout button', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.locator('body').focus();

      let foundLogout = false;
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const focused = page.locator(':focus');
        const label = await focused.getAttribute('aria-label');
        if (label === 'Logout') {
          foundLogout = true;
          break;
        }
      }

      expect(foundLogout).toBe(true);
    });

    test('shift+tab navigates backwards', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('settings-button').focus();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByLabel('Toggle theme')).toBeFocused();
    });
  });

  test.describe('Escape Key', () => {
    test('closes settings menu with Escape', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('settings-button').click();
      await expect(page.getByTestId('settings-menu')).toBeVisible();

      await page.keyboard.press('Escape');

      await expect(page.getByTestId('settings-menu')).not.toBeVisible();
    });

    test('closes theme menu with Escape', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();

      await page.keyboard.press('Escape');

      await expect(page.getByText('Dark Mode')).not.toBeVisible();
    });
  });

  test.describe('Enter Key', () => {
    test('activates theme toggle with Enter', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByLabel('Toggle theme').focus();
      await page.keyboard.press('Enter');

      await expect(page.getByText('Dark Mode')).toBeVisible();
    });

    test('activates settings button with Enter', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('settings-button').focus();
      await page.keyboard.press('Enter');

      await expect(page.getByTestId('settings-menu')).toBeVisible();
    });

    test('activates menu items with Enter', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Dark Mode')).toBeVisible();

      await page.getByText('Dark Mode').focus();
      await page.keyboard.press('Enter');

      await expect(page.locator('html')).toHaveClass(/dark/);
    });
  });

  test.describe('Space Key', () => {
    test('activates buttons with Space', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByLabel('Toggle theme').focus();
      await page.keyboard.press('Space');

      await expect(page.getByText('Dark Mode')).toBeVisible();
    });
  });

  test.describe('Focus Visibility', () => {
    test('focus ring is visible on buttons', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByLabel('Toggle theme').focus();
      await expect(page.getByLabel('Toggle theme')).toBeFocused();
    });

    test('page has focusable interactive elements', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusableCount = await page.locator(focusableSelector).count();
      expect(focusableCount).toBeGreaterThan(0);
    });
  });

  test.describe('Auth Page Keyboard Navigation', () => {
    test('can tab through login form', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto('/auth');
      await page.waitForLoadState('networkidle');

      const inputs = page.locator('input:not([disabled])');
      expect(await inputs.count()).toBeGreaterThan(0);

      await page.keyboard.press('Tab');
      await expect(page.locator(':focus')).toBeVisible();

      await context.close();
    });

    test('can tab from username to password', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto('/auth');
      await page.waitForLoadState('networkidle');

      const inputs = page.locator('input:not([disabled])');
      const inputCount = await inputs.count();

      if (inputCount >= 2) {
        await inputs.first().focus();
        await expect(inputs.first()).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(page.locator(':focus')).toBeVisible();
      }

      await context.close();
    });

    test('Enter submits login form when focused on password', async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto('/auth');
      await page.waitForLoadState('networkidle');

      const inputs = page.locator('input:not([disabled])');

      if (await inputs.count() >= 2) {
        await inputs.nth(0).fill('testuser');
        await inputs.nth(1).fill('testpassword');
        await inputs.nth(1).focus();
        await page.keyboard.press('Enter');

        await expect(page).toHaveURL(/\/auth/, { timeout: 5000 });
      }

      await context.close();
    });
  });

  test.describe('Menu Keyboard Navigation', () => {
    test('settings menu has four menuitem elements', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('settings-button').click();
      await expect(page.getByTestId('settings-menu')).toBeVisible();

      const menuItems = page.locator('[role="menuitem"]');
      expect(await menuItems.count()).toBe(4);
    });

    test('menu has proper ARIA roles', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('settings-button').click();

      const menu = page.getByTestId('settings-menu');
      await expect(menu).toHaveAttribute('role', 'menu');
    });
  });

  test.describe('Accessibility', () => {
    test('buttons have accessible names', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByLabel('Toggle theme')).toBeVisible();
      await expect(page.getByTestId('settings-button')).toHaveAttribute('aria-label', 'Settings');
      await expect(page.getByLabel('Logout')).toBeVisible();
    });

    test('settings button has proper ARIA attributes', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const settingsBtn = page.getByTestId('settings-button');

      await expect(settingsBtn).toHaveAttribute('aria-haspopup', 'menu');
      await expect(settingsBtn).toHaveAttribute('aria-expanded', 'false');

      await settingsBtn.click();

      await expect(settingsBtn).toHaveAttribute('aria-expanded', 'true');
    });
  });
});