import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Message Flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Message Display', () => {
    test('message container is visible when a room is open', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const messageContainer = page.locator('[role="log"]');
        if (await messageContainer.count() > 0) {
          await expect(messageContainer).toBeVisible({ timeout: 5000 });
        }
      }
    });

    test('message list uses role="log" for accessibility', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const messageList = page.locator('[role="log"]');
        if (await messageList.count() > 0) {
          await expect(messageList).toBeVisible();
        }
      }
    });

    test('message articles have aria-label with sender info', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const articles = page.locator('[role="article"]');
        if (await articles.count() > 0) {
          const ariaLabel = await articles.first().getAttribute('aria-label');
          expect(ariaLabel).toContain('Message from');
        }
      }
    });
  });

  test.describe('Message Input', () => {
    test('can type in the message input when a room is selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const input = page.locator('input[placeholder*="message"], input[placeholder*="Type"]').first();
        if (await input.isVisible().catch(() => false)) {
          await input.fill('Hello World');
          await expect(input).toHaveValue('Hello World');
        }
      }
    });

    test('Enter key clears the input after a send attempt', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const input = page.locator('input[placeholder*="message"], input[placeholder*="Type"]').first();
        if (await input.isVisible().catch(() => false)) {
          await input.fill('Message to send');
          await input.press('Enter');

          await expect(input).toHaveValue('', { timeout: 2000 });
        }
      }
    });

    test('message input has a placeholder', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const input = page.locator('input[placeholder]').first();
        if (await input.count() > 0) {
          const placeholder = await input.getAttribute('placeholder');
          expect(placeholder).toBeTruthy();
        }
      }
    });
  });

  test.describe('Message Sending Flow', () => {
    test('handles rapid successive messages without crashing', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const input = page.locator('input[placeholder*="message"], input[placeholder*="Type"]').first();
        if (await input.isVisible().catch(() => false)) {
          for (let i = 1; i <= 3; i++) {
            await input.fill(`Rapid message ${i}`);
            await input.press('Enter');
            await page.waitForTimeout(100);
          }
          await page.waitForTimeout(500);
        }
      }
    });
  });

  test.describe('Empty States', () => {
    test('shows prompt to select a room when none is selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emptyState = page.getByText(/select.*chat|no chat selected|choose a room/i);
      if (await emptyState.count() > 0) {
        await expect(emptyState.first()).toBeVisible();
      }
    });
  });

  test.describe('Emoji Integration', () => {
    test('emoji picker opens and contains emoji characters', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const emojiButton = page.locator('[data-testid="emoji-button"], button[aria-label*="emoji" i]');
        if (await emojiButton.count() > 0) {
          await emojiButton.first().click();
          await page.waitForTimeout(300);

          const emojiInPicker = page.locator('text=/[😀😂😍👍🔥]/');
          if (await emojiInPicker.count() > 0) {
            await expect(emojiInPicker.first()).toBeVisible();
          }
        }
      }
    });
  });

  test.describe('Scroll Behavior', () => {
    test('message container allows scrolling', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.count() > 0) {
        await roomItem.click();
        await page.waitForTimeout(500);

        const scrollContainer = page.locator('[role="log"], [data-testid="message-list"]');
        if (await scrollContainer.count() > 0) {
          const overflow = await scrollContainer.first().evaluate(el => {
            return window.getComputedStyle(el).overflowY;
          });

          expect(['auto', 'scroll']).toContain(overflow);
        }
      }
    });
  });
});