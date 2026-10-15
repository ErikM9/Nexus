import type { Page } from '@playwright/test';

/* Makes the next page load start in the given theme, the way a returning user's saved choice does */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
}