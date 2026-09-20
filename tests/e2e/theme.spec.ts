import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Theme', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Theme Toggle', () => {
    test('displays theme toggle button', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByLabel('Toggle theme')).toBeVisible({ timeout: 15000 });
    });

    test('opens theme menu on click', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('Toggle theme').click();

      await expect(page.getByText('Light Mode')).toBeVisible();
      await expect(page.getByText('Dark Mode')).toBeVisible();
    });

    test('switches to dark mode', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();

      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('switches to light mode', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Light Mode').click();

      await expect(page.locator('html')).not.toHaveClass(/dark/);
    });

    test('closes theme menu after selection', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await expect(page.getByText('Light Mode')).toBeVisible();

      await page.getByText('Dark Mode').click();

      await expect(page.getByText('Light Mode')).not.toBeVisible();
    });
  });

  test.describe('Theme Persistence', () => {
    test('persists dark mode across page reload', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await page.reload();
      await page.waitForLoadState('networkidle');

      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('persists light mode across page reload', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Light Mode').click();
      await expect(page.locator('html')).not.toHaveClass(/dark/);

      await page.reload();
      await page.waitForLoadState('networkidle');

      await expect(page.locator('html')).not.toHaveClass(/dark/);
    });

    test('persists theme across navigation', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await page.goto('/auth');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(/dark/);

      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(/dark/);
    });
  });

  test.describe('Theme Visual Indicators', () => {
    test('highlights current theme in menu', async ({ page }) => {
      await page.goto('/');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();

      await page.getByLabel('Toggle theme').click();

      const darkModeButton = page.getByText('Dark Mode');
      await expect(darkModeButton).toHaveClass(/font-semibold/);
    });
  });

  test.describe('Theme on Auth Page', () => {
    test('theme toggle works on auth page', async ({ page }) => {
      await page.goto('/auth');

      await expect(page.getByLabel('Toggle theme')).toBeVisible({ timeout: 15000 });

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();

      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('theme set on auth page persists into main app', async ({ page }) => {
      await page.goto('/auth');

      await page.getByLabel('Toggle theme').click();
      await page.getByText('Dark Mode').click();
      await expect(page.locator('html')).toHaveClass(/dark/);

      await setupAuthenticatedSession(page);
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('html')).toHaveClass(/dark/);
    });
  });
});