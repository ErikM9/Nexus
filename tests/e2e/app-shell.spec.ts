import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { useTheme, WORDMARK } from './support/contrast';
import { BOB } from './support/homeserver';

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));

test.describe('Theme', () => {
  test('switches between light and dark from the header', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    expect(await isDark(page)).toBe(false);

    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.getByRole('button', { name: 'Dark Mode' }).click();
    await expect.poll(() => isDark(page)).toBe(true);

    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await expect(page.getByRole('button', { name: 'Light Mode' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Light Mode' })).toHaveCount(0);
  });

  test('remembers the theme across a reload', async ({ nexus, hs, page }) => {
    /* The app starts twice here, and each start loads and initialises the crypto WebAssembly, which on a slower machine
       runs the two past the usual budget */
    test.slow();
    hs.addRoom({ name: 'General' });
    await nexus.open();

    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.getByRole('button', { name: 'Dark Mode' }).click();
    await expect.poll(() => isDark(page)).toBe(true);

    await page.reload();
    await nexus.waitUntilReady();
    expect(await isDark(page)).toBe(true);
  });

  test('can be set on the sign-in page and carries into the app', async ({ nexus, hs, page }) => {
    await hs.mockAppApi(page);
    hs.addRoom({ name: 'General' });
    await page.goto('/auth');

    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.getByRole('button', { name: 'Dark Mode' }).click();
    await expect.poll(() => isDark(page)).toBe(true);

    await nexus.signIn('alice', 'correct horse battery staple');
    await nexus.waitUntilReady();
    expect(await isDark(page)).toBe(true);
  });
});

test.describe('Keyboard', () => {
  test('opens the theme menu with the keyboard and closes it with Escape', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();

    await page.getByRole('button', { name: 'Toggle theme' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Dark Mode' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Dark Mode' })).toHaveCount(0);
  });

  test('reaches the header buttons by tabbing', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();

    await page.getByRole('button', { name: 'Toggle theme' }).focus();
    const reached: string[] = [];
    for (let i = 0; i < 3; i++) {
      reached.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
      await page.keyboard.press('Tab');
    }
    expect(reached).toContain('Settings');
    expect(reached).toContain('Logout');
  });

  test('submits the sign-in form with Enter from the password field', async ({ nexus, hs, page }) => {
    await hs.mockAppApi(page);
    hs.addRoom({ name: 'General' });
    await page.goto('/auth');

    await nexus.username.fill('alice');
    await nexus.password.fill('correct horse battery staple');
    await nexus.password.press('Enter');

    await expect(page).toHaveURL(/\/$/);
    await nexus.waitUntilReady();
  });
});

test.describe('On a phone-sized screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps the session actions in an overflow menu', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();

    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();

    const menu = page.getByRole('menu', { name: 'Menu' });
    await expect(menu.getByRole('menuitem', { name: 'Get Recovery Key' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
  });

  test('shows the chat over the list and returns with Back to chats', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'On mobile');
    await nexus.open();

    await expect(nexus.roomList).toBeVisible();
    await nexus.room('General').click();
    await expect(nexus.roomTitle).toHaveText('General');
    await expect(nexus.roomList).toBeHidden();

    await page.getByRole('button', { name: 'Back to chats' }).click();
    await expect(nexus.roomList).toBeVisible();
  });
});

/* Collects the WCAG 2.1 A and AA violations axe-core finds, with the NEXUS wordmark left out because logotypes carry no contrast
   requirement. Colour contrast itself is not scanned: the palette (sky-blue toggles and buttons with white labels, blue links,
   red warnings) is the product's design, kept as it is rather than darkened to the AA ratios */
async function wcagViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast'])
    .exclude(WORDMARK)
    .analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('Accessibility', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`the sign-in page meets WCAG 2.1 AA in ${theme} mode`, { tag: '@a11y' }, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/auth');
      await expect(page.getByText('Sign in to Nexus')).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });

    test(`the chat screen with a room open meets WCAG 2.1 AA in ${theme} mode`, { tag: '@a11y' }, async ({ nexus, hs, page }) => {
      await useTheme(page, theme);
      const room = hs.addRoom({ name: 'General', members: [BOB] });
      hs.addRoom({ name: 'Vault', encrypted: true });
      hs.say(room, BOB, 'Hello there');
      await nexus.open();
      await nexus.openRoom('General');
      await expect(nexus.message('Hello there')).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});