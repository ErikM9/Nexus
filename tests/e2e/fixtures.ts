import { Page } from '@playwright/test';

/* Seeds fake Matrix session tokens and ready flags so authenticated specs skip loading states */

export async function setupAuthenticatedSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('mx_access_token', 'test_token');
    localStorage.setItem('mx_user_id', '@testuser:matrix.org');
    localStorage.setItem('mx_device_id', 'TESTDEVICE');
    localStorage.setItem('mx_session', JSON.stringify({
      accessToken: 'test_token',
      userId: '@testuser:matrix.org',
      deviceId: 'TESTDEVICE',
      baseUrl: 'https://matrix.org',
    }));
    (window as any).__matrix_ready = true;
    (window as any).__cryptoReady = true;
  });
}