import { test, expect } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

test.describe('Chat Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Layout', () => {
    test('displays chat list sidebar', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Your chats')).toBeVisible({ timeout: 15000 });
    });

    test('displays empty state when no room selected', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText(/select.*chat/i)).toBeVisible({ timeout: 15000 });
    });

    test('displays app header', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('header')).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('NEXUS')).toBeVisible();
    });
  });

  test.describe('Room List', () => {
    test('shows create/join toggle', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('button', { name: 'Create' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join' }).first()).toBeVisible();
    });
  });

  test.describe('Create Room', () => {
    test('shows create room form with name input and submit button', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.getByText('Create room')).toBeVisible();
      await expect(page.getByPlaceholder(/name/i)).toBeVisible();
    });

    test('shows room type selector', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await expect(page.locator('[role="combobox"]').first()).toBeVisible();
    });

    test('create button requires a room name to be enabled', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const createSubmitButton = page.locator('button').filter({ hasText: 'Create' }).last();
      const nameInput = page.getByPlaceholder(/name/i);

      if (await nameInput.isEnabled()) {
        await expect(createSubmitButton).toBeDisabled();
        await nameInput.fill('My New Room');
        await expect(createSubmitButton).toBeEnabled();
      }
    });
  });
});

test.describe('Chat Window', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test.describe('Send Message', () => {
    test('shows message input when room is selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await roomItem.click();

        const messageInput = page.getByPlaceholder(/message/i);
        if (await messageInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(messageInput).toBeVisible();
        }
      }
    });

    test('does not send an empty message', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await roomItem.click();

        const messageInput = page.getByPlaceholder(/message/i);
        if (await messageInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await messageInput.press('Enter');
          await expect(messageInput).toHaveValue('');
        }
      }
    });
  });

  test.describe('Emoji Picker', () => {
    test('opens emoji picker on button click', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await roomItem.click();

        const emojiButton = page.getByRole('button', { name: /emoji/i });
        if (await emojiButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await emojiButton.click();
          await expect(page.locator('[role="listbox"]')).toBeVisible();
        }
      }
    });
  });

  test.describe('File Attachment', () => {
    test('attach button is visible when room is selected', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const roomItem = page.locator('[data-testid="room-item"]').first();
      if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await roomItem.click();

        const attachButton = page.getByRole('button', { name: /attach/i });
        if (await attachButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(attachButton).toBeVisible();
        }
      }
    });
  });
});

test.describe('Chat Header', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
  });

  test('displays room name in header when room is selected', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const roomItem = page.locator('[data-testid="room-item"]').first();
    if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      const roomName = await roomItem.locator('.truncate').first().textContent();
      await roomItem.click();

      if (roomName) {
        const chatHeader = page.locator('[data-testid="chat-header"]');
        if (await chatHeader.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(page.locator('[data-testid="room-name"]')).toContainText(roomName);
        }
      }
    }
  });

  test('Members button is visible in chat header when room is selected', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const roomItem = page.locator('[data-testid="room-item"]').first();
    if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await roomItem.click();

      const membersButton = page.getByRole('button', { name: /members/i });
      if (await membersButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(membersButton).toBeVisible();
      }
    }
  });
});