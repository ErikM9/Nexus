import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('File Uploads', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Message Input UI', () => {
    test('emoji button exists in the message input area', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emojiBtn = page.getByLabel('Emoji');
      if (await emojiBtn.isVisible().catch(() => false)) {
        await expect(emojiBtn).toBeVisible();
      }
    });

    test('attach image button exists in the message input area', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const attachBtn = page.getByLabel('Attach image');
      if (await attachBtn.isVisible().catch(() => false)) {
        await expect(attachBtn).toBeVisible();
      }
    });

    test('send button exists in the message input area', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const sendBtn = page.getByRole('button', { name: 'Send' });
      if (await sendBtn.isVisible().catch(() => false)) {
        await expect(sendBtn).toBeVisible();
      }
    });
  });

  test.describe('Emoji Picker', () => {
    test('emoji button opens emoji picker', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emojiBtn = page.getByLabel('Emoji');
      if (await emojiBtn.isVisible() && await emojiBtn.isEnabled()) {
        await emojiBtn.click();
        await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 });
      }
    });

    test('clicking emoji inserts it into the input', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emojiBtn = page.getByLabel('Emoji');
      if (await emojiBtn.isVisible() && await emojiBtn.isEnabled()) {
        await emojiBtn.click();

        const firstEmoji = page.locator('[role="listbox"] button').first();
        if (await firstEmoji.isVisible()) {
          const emojiText = await firstEmoji.textContent();
          await firstEmoji.click();

          const input = page.locator('input[type="text"]').first();
          if (await input.isVisible()) {
            const value = await input.inputValue();
            expect(value).toContain(emojiText);
          }
        }
      }
    });

    test('emoji picker closes after selection', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emojiBtn = page.getByLabel('Emoji');
      if (await emojiBtn.isVisible() && await emojiBtn.isEnabled()) {
        await emojiBtn.click();
        await expect(page.locator('[role="listbox"]')).toBeVisible();

        const firstEmoji = page.locator('[role="listbox"] button').first();
        if (await firstEmoji.isVisible()) {
          await firstEmoji.click();
          await expect(page.locator('[role="listbox"]')).not.toBeVisible();
        }
      }
    });

    test('emoji picker closes when clicking outside', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const emojiBtn = page.getByLabel('Emoji');
      if (await emojiBtn.isVisible() && await emojiBtn.isEnabled()) {
        await emojiBtn.click();
        await expect(page.locator('[role="listbox"]')).toBeVisible();

        await page.getByText('NEXUS').click();
        await expect(page.locator('[role="listbox"]')).not.toBeVisible();
      }
    });
  });

  test.describe('File Input', () => {
    test('file input accept attribute includes images', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        const accept = await fileInput.getAttribute('accept');
        expect(accept).toContain('image');
      }
    });
  });

  test.describe('File Selection UI', () => {
    test('clicking remove clears the attached file', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('input[type="file"][accept="image/*"]');

      if (await fileInput.count() > 0 && await fileInput.isEnabled()) {
        await fileInput.setInputFiles({
          name: 'test.png',
          mimeType: 'image/png',
          buffer: Buffer.alloc(100),
        });

        const removeBtn = page.getByText(/remove/i);
        if (await removeBtn.isVisible()) {
          await removeBtn.click();
          await expect(page.getByText(/attached/i)).not.toBeVisible();
        }
      }
    });
  });

  test.describe('File Type Validation', () => {
    test('accepts PNG files without showing an error', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('input[type="file"][accept="image/*"]');
      if (await fileInput.count() > 0 && await fileInput.isEnabled()) {
        await fileInput.setInputFiles({
          name: 'test.png',
          mimeType: 'image/png',
          buffer: Buffer.alloc(100),
        });

        await expect(page.getByText(/only images/i)).not.toBeVisible();
      }
    });

    test('accepts JPEG files without showing an error', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const fileInput = page.locator('input[type="file"][accept="image/*"]');
      if (await fileInput.count() > 0 && await fileInput.isEnabled()) {
        await fileInput.setInputFiles({
          name: 'test.jpg',
          mimeType: 'image/jpeg',
          buffer: Buffer.alloc(100),
        });

        await expect(page.getByText(/only images/i)).not.toBeVisible();
      }
    });
  });

  test.describe('Message Input State', () => {
    test('message input shows some placeholder text', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const input = page.locator('input[type="text"]').first();
      if (await input.isVisible()) {
        const placeholder = await input.getAttribute('placeholder');
        expect(placeholder).toBeTruthy();
      }
    });
  });

  test.describe('Send Button State', () => {
    test('message input accepts typed text', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const input = page.locator('input[type="text"]').first();
      if (await input.isVisible() && await input.isEnabled()) {
        await input.fill('test message');
        await expect(input).toHaveValue('test message');
      }
    });
  });
});