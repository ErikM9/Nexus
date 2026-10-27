import type { Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { BOB } from './support/homeserver';
import { useTheme } from './support/theme';

type Band = { top: number; bottom: number };

const box = async (locator: Locator): Promise<Band> => {
  const { y, height } = (await locator.boundingBox())!;
  return { top: y, bottom: y + height };
};

/* The capitals of an element's first line, read from a zero-width box one capital tall standing on its baseline */
const capitals = (locator: Locator): Promise<Band> =>
  locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const text = walker.nextNode() as Text;
    /* The wrapper keeps the probe on the text's own line where the text is a flex item */
    const wrapper = document.createElement('span');
    const probe = document.createElement('span');
    probe.style.cssText = 'display: inline-block; width: 0; height: 1cap; vertical-align: baseline';
    text.before(wrapper);
    wrapper.append(probe, text);
    const { top, bottom } = probe.getBoundingClientRect();
    wrapper.before(text);
    wrapper.remove();
    return { top, bottom };
  });

/* How far the middle of a label's capitals stands from the middle of the label's box */
const offCentre = async (label: Locator) => {
  const caps = await capitals(label);
  const { top, bottom } = await box(label);
  return (caps.top + caps.bottom) / 2 - (top + bottom) / 2;
};

const fontsLoaded = (page: Page) => page.evaluate(async () => { await document.fonts.ready; });

/* The inner edge of the card's top border, on a card the larger screens scale up */
const cardTop = (page: Page) =>
  page.getByTestId('auth-card').evaluate((card: HTMLElement) => {
    const rect = card.getBoundingClientRect();
    return rect.top + parseFloat(getComputedStyle(card).borderTopWidth) * (rect.height / card.offsetHeight);
  });

/* The open menu, or the theme menu, which has no role of its own */
const openMenu = (page: Page) => page.getByRole('menu').or(page.getByRole('button', { name: 'Dark Mode' }).locator('..'));

/* Whether anything behind a menu shows through it, from shots of its inside over a black sheet and then a white one */
const showsThrough = async (page: Page, menu: Locator) => {
  /* A menu that grows as it opens is measured once it has opened */
  await menu.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  /* The shots stay a corner's radius in from each edge, as the page rightly shows beyond the rounded corners */
  const { x, y, width, height } = (await menu.boundingBox())!;
  const radius = await menu.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius));
  const clip = { x: x + radius, y: y + radius, width: width - 2 * radius, height: height - 2 * radius };
  const inside = () => page.screenshot({ clip, animations: 'disabled' });

  /* The sheet sits just before the menu's top element at the same z-index, so it covers the page but not the menu */
  const sheet = await menu.evaluateHandle((element) => {
    let layer: Element = element;
    while (layer.parentElement !== document.body) layer = layer.parentElement!;
    const div = document.createElement('div');
    div.style.cssText = `position: fixed; inset: 0; z-index: ${getComputedStyle(layer).zIndex}; background: black`;
    layer.before(div);
    return div;
  });
  const overBlack = await inside();
  await sheet.evaluate((div) => {
    div.style.background = 'white';
  });
  const overWhite = await inside();
  await sheet.evaluate((div) => div.remove());
  return !overBlack.equals(overWhite);
};

test.describe('Text centring', () => {
  test('centres the capitals of the sign-in buttons within the buttons', async ({ nexus, page }) => {
    await page.goto('/auth');
    await fontsLoaded(page);

    for (const label of [
      page.getByRole('button', { name: 'Sign in', exact: true }).first(),
      page.getByRole('button', { name: 'Sign up', exact: true }),
      nexus.signInButton,
    ]) {
      expect(Math.abs(await offCentre(label))).toBeLessThan(0.75);
    }
  });

  test('centres the capitals of the chat screen buttons and status pills within them', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();
    await nexus.openRoom('General');
    await page.getByRole('button', { name: 'Room settings' }).click();
    await fontsLoaded(page);

    for (const label of [
      nexus.createToggle,
      nexus.joinToggle,
      nexus.createButton,
      nexus.sendButton,
      page.getByText('Private', { exact: true }),
      page.getByText('Not encrypted', { exact: true }),
    ]) {
      expect(Math.abs(await offCentre(label))).toBeLessThan(0.75);
    }
  });
});

test.describe('Sign-in card on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('centres the mode toggle between the top of the card and the title, in the same place on both forms', async ({ page }) => {
    await page.goto('/auth');
    await fontsLoaded(page);
    const toggle = page.getByRole('button', { name: 'Sign in', exact: true }).first().locator('..');

    const signIn = await box(toggle);
    const top = await cardTop(page);
    const title = await capitals(page.getByText('Sign in to Nexus'));
    expect(Math.abs((signIn.top - top) - (title.top - signIn.bottom))).toBeLessThan(1);

    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await expect(page.getByText('Create your Matrix account')).toBeVisible();

    expect((await box(toggle)).top).toBeCloseTo(signIn.top, 1);
  });
});

for (const [screen, viewport] of [
  ['a phone', { width: 390, height: 844 }],
  ['a desktop', { width: 1280, height: 720 }],
] as const) {
  test.describe(`Sign-in card buttons on ${screen}`, () => {
    test.use({ viewport });

    test('stand as far from the field or explanation above as from the line below, in the same place on both forms', async ({ nexus, page }) => {
      await page.goto('/auth');
      await fontsLoaded(page);
      const signIn = await box(nexus.signInButton);
      const password = await box(nexus.password);
      const switchToSignUp = await capitals(page.getByText('New to Matrix?'));
      expect(Math.abs((signIn.top - password.bottom) - (switchToSignUp.top - signIn.bottom))).toBeLessThan(1);

      await page.getByRole('button', { name: 'Create an account' }).click();
      await expect(page.getByText('Create your Matrix account')).toBeVisible();
      const signUp = await box(page.getByRole('button', { name: 'Sign up', exact: true }).last());
      const explanation = await box(page.getByText('How does this work?').locator('..'));
      const switchToSignIn = await capitals(page.getByText('Already have an account?'));

      expect(Math.abs((signUp.top - explanation.bottom) - (switchToSignIn.top - signUp.bottom))).toBeLessThan(1);
      expect(signUp.top).toBeCloseTo(signIn.top, 0);
    });
  });
}

for (const [screen, viewport, headerMenus] of [
  ['a phone', { width: 390, height: 844 }, ['Menu']],
  ['a desktop', { width: 1280, height: 720 }, ['Toggle theme', 'Settings']],
] as const) {
  test.describe(`Menus on ${screen}`, () => {
    test.use({ viewport });

    for (const theme of ['light', 'dark'] as const) {
      test(`hide what lies behind them in the ${theme} theme`, async ({ nexus, hs, page }) => {
        await useTheme(page, theme);
        hs.addRoom({ name: 'General', members: [BOB] });
        await nexus.open();
        await nexus.openRoom('General');

        for (const name of [...headerMenus, 'Room settings', 'Members', 'Room options']) {
          await page.getByRole('button', { name, exact: true }).click();
          expect.soft(await showsThrough(page, openMenu(page)), name).toBe(false);
          await page.keyboard.press('Escape');
          await expect(openMenu(page)).toHaveCount(0);
        }
      });
    }
  });
}