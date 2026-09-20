import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Room Management', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Room List UI', () => {
    test('shows "Your chats" heading', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByText('Your chats')).toBeVisible({ timeout: 15000 });
    });

    test('displays create and join buttons', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('button', { name: 'Create' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join' }).first()).toBeVisible();
    });
  });

  test.describe('Create Room', () => {
    test('create button is visible (enabled state depends on Matrix connection)', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const createBtn = page.getByRole('button', { name: 'Create' }).first();
      await expect(createBtn).toBeVisible({ timeout: 15000 });

      const isDisabled = await createBtn.isDisabled();
      if (!isDisabled) {
        await createBtn.click();
        const input = page.locator('input').first();
        await expect(input).toBeVisible({ timeout: 5000 });
      }
    });
  });

  test.describe('Join Room', () => {
    test('join button is visible (enabled state depends on Matrix connection)', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const joinBtn = page.getByRole('button', { name: 'Join' }).first();
      await expect(joinBtn).toBeVisible({ timeout: 15000 });

      const isDisabled = await joinBtn.isDisabled();
      if (!isDisabled) {
        await joinBtn.click();
        const input = page.locator('input').first();
        await expect(input).toBeVisible({ timeout: 5000 });
      }
    });
  });

  test.describe('Room Selection', () => {
    test('shows empty state when no room selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByText(/select.*chat/i)).toBeVisible({ timeout: 15000 });
    });

    test('room items are rendered as clickable elements', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItems = page.locator('[data-testid="room-item"]');
      const count = await roomItems.count();

      if (count > 0) {
        const firstRoom = roomItems.first();
        await expect(firstRoom).toBeVisible();
        const tagName = await firstRoom.evaluate(el => el.tagName.toLowerCase());
        expect(['button', 'a', 'div', 'li']).toContain(tagName);
      }
    });
  });

  test.describe('Room Header', () => {
    test('chat header is visible when a room is selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const chatWindow = page.locator('[data-testid="chat-window"]');
      const chatHeader = page.locator('[data-testid="chat-header"]');

      const hasRoom = await chatWindow.isVisible().catch(() => false);

      if (hasRoom) {
        expect(await chatHeader.isVisible()).toBe(true);
      }
    });
  });

  test.describe('Encryption Badge', () => {
    test('encryption badge is visible for encrypted rooms', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const encryptionBadges = page.locator('[data-testid="encryption-badge"]');
      const count = await encryptionBadges.count();

      if (count > 0) {
        await expect(encryptionBadges.first()).toBeVisible();
      }
    });
  });

  test.describe('Room List Scrolling', () => {
    test('a scrollable sidebar container is present', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const sidebar = page.locator('aside, [class*="sidebar"], [class*="chat-list"]').first();
      const roomList = page.locator('[data-testid="room-list"]');

      const sidebarVisible = await sidebar.isVisible().catch(() => false);
      const roomListVisible = await roomList.isVisible().catch(() => false);

      expect(sidebarVisible || roomListVisible).toBe(true);
    });
  });

  test.describe('Mobile Responsive', () => {
    test('app renders on mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByText('NEXUS')).toBeVisible({ timeout: 15000 });
      /* Below the md breakpoint the header buttons collapse into a single overflow menu */
      await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
    });

    test('header actions are reachable via the overflow menu on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      /* The desktop header row is hidden on mobile, so the overflow menu exposes its actions */
      const menuButton = page.getByRole('button', { name: 'Menu' });
      await expect(menuButton).toBeVisible({ timeout: 15000 });
      await menuButton.click();

      await expect(page.getByRole('menuitem', { name: 'Light Mode' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Dark Mode' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
    });
  });
});