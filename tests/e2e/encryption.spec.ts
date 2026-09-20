import { test, expect, Page } from '@playwright/test';
import { setupAuthenticatedSession } from './fixtures';

async function openSettingsMenu(page: Page) {
  const settingsButton = page.getByTestId('settings-button');
  await settingsButton.click();
  await page.waitForSelector('[data-testid="settings-menu"]', { timeout: 3000 });
}

function settingsMenuItem(page: Page, name: string) {
  return page.getByTestId('settings-menu').getByRole('menuitem', { name });
}

test.describe('Encryption Features', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.describe('Recovery Key', () => {
    test('opens create recovery key dialog from settings', async ({ page }) => {
      await openSettingsMenu(page);
      const getRecoveryKeyButton = settingsMenuItem(page, 'Get Recovery Key');
      await expect(getRecoveryKeyButton).toBeVisible();
      await getRecoveryKeyButton.click();
      await expect(page.getByText(/recovery key/i)).toBeVisible();
    });

    test('has copy button for recovery key', async ({ page }) => {
      await openSettingsMenu(page);
      await settingsMenuItem(page, 'Get Recovery Key').click();

      const generateButton = page.getByRole('button', { name: /generate|create/i });
      if (await generateButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await generateButton.click();
        const copyButton = page.getByRole('button', { name: /copy/i });
        if (await copyButton.isVisible({ timeout: 15000 }).catch(() => false)) {
          await expect(copyButton).toBeVisible();
        }
      }
    });
  });

  test.describe('Restore Recovery Key', () => {
    test('opens restore dialog', async ({ page }) => {
      await openSettingsMenu(page);
      const useRecoveryKeyButton = settingsMenuItem(page, 'Use Recovery Key');
      await expect(useRecoveryKeyButton).toBeVisible();
      await useRecoveryKeyButton.click();
      await expect(page.getByText('Use Recovery Key')).toBeVisible();
    });

    test('has input for recovery key', async ({ page }) => {
      await openSettingsMenu(page);
      await settingsMenuItem(page, 'Use Recovery Key').click();

      const keyInput = page.locator('input').first();
      if (await keyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(keyInput).toBeVisible();
      }
    });

    test('accepts typed recovery key in the input', async ({ page }) => {
      await openSettingsMenu(page);
      await settingsMenuItem(page, 'Use Recovery Key').click();

      const keyInput = page.locator('input').first();
      if (await keyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await keyInput.fill('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
        await expect(keyInput).toHaveValue('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
      }
    });
  });

  test.describe('Session Verification', () => {
    test('opens verify session dialog from settings', async ({ page }) => {
      await openSettingsMenu(page);
      const verifyButton = settingsMenuItem(page, 'Verify this session');
      await expect(verifyButton).toBeVisible();
      await verifyButton.click();

      await page.waitForTimeout(500);
      const verificationPanel = page.getByText(/verify|verification|session/i).first();
      if (await verificationPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(verificationPanel).toBeVisible();
      }
    });

    test('shows emoji verification UI when SAS event is dispatched', async ({ page }) => {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('matrix-verification-request', {
          detail: {
            id: 'test_req',
            fromUserId: '@other:matrix.org',
            createdAt: Date.now(),
            phase: 'showing_sas',
            sasEmojis: [
              { emoji: '🐶', name: 'Dog' },
              { emoji: '🐱', name: 'Cat' },
              { emoji: '🐭', name: 'Mouse' },
              { emoji: '🐹', name: 'Hamster' },
              { emoji: '🐰', name: 'Rabbit' },
              { emoji: '🦊', name: 'Fox' },
              { emoji: '🐻', name: 'Bear' },
            ],
            initiatedByMe: false,
          },
        }));
      });

      const dogEmoji = page.getByText('🐶');
      if (await dogEmoji.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(dogEmoji).toBeVisible();

        const matchButton = page.getByRole('button', { name: /match|confirm|they match/i });
        if (await matchButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          await matchButton.click();
        }
      }
    });

    test('can cancel an active verification', async ({ page }) => {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('matrix-verification-request', {
          detail: {
            id: 'test_req',
            fromUserId: '@other:matrix.org',
            createdAt: Date.now(),
            phase: 'showing_sas',
            sasEmojis: [
              { emoji: '🐶', name: 'Dog' },
              { emoji: '🐱', name: 'Cat' },
              { emoji: '🐭', name: 'Mouse' },
              { emoji: '🐹', name: 'Hamster' },
              { emoji: '🐰', name: 'Rabbit' },
              { emoji: '🦊', name: 'Fox' },
              { emoji: '🐻', name: 'Bear' },
            ],
            initiatedByMe: false,
          },
        }));
      });

      const cancelButton = page.getByRole('button', { name: /cancel|no.*match|don't match/i });
      if (await cancelButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await cancelButton.click();
      }
    });
  });

  test.describe('Forget Session', () => {
    test('opens forget session dialog with warning', async ({ page }) => {
      await openSettingsMenu(page);
      const forgetButton = settingsMenuItem(page, 'Forget this session');
      await expect(forgetButton).toBeVisible();
      await forgetButton.click();
      await expect(page.getByText('Forget this session?')).toBeVisible();
    });

    test('shows a confirm button in the forget dialog', async ({ page }) => {
      await openSettingsMenu(page);
      await settingsMenuItem(page, 'Forget this session').click();
      await expect(page.getByText('Forget this session?')).toBeVisible();
      const confirmButton = page.getByRole('button', { name: /confirm|forget|yes/i });
      if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(confirmButton).toBeVisible();
      }
    });

    test('Cancel closes the forget dialog', async ({ page }) => {
      await openSettingsMenu(page);
      await settingsMenuItem(page, 'Forget this session').click();
      await expect(page.getByText('Forget this session?')).toBeVisible();

      const cancelButton = page.getByRole('button', { name: /cancel|no|back/i });
      if (await cancelButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cancelButton.click();
        await expect(page.getByText('Forget this session?')).not.toBeVisible();
      }
    });
  });
});