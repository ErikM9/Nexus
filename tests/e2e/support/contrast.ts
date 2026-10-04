import type { Page } from '@playwright/test';

/* WCAG 1.4.3 sets no contrast minimum for text that is part of a logo or brand name, which is what the NEXUS wordmark is */
export const WORDMARK = 'header .font-thehook';

/* Makes the next page load start in the given theme, the way a returning user's saved choice does */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
}