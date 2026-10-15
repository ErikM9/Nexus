import { defineConfig, devices } from '@playwright/test';

/* Placeholder homeserver for the app's own login and logout routes, so a spec that reaches them never contacts a real one */
const homeserverEnv = {
  NEXT_PUBLIC_MATRIX_HOMESERVER: process.env.NEXT_PUBLIC_MATRIX_HOMESERVER ?? 'https://homeserver.example',
  MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER ?? 'https://homeserver.example',
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(process.env.CI ? [['github'] as const] : []),
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 60 * 1000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    /* The specs run against a production build, which CI has already made in an earlier step */
    command: process.env.CI ? 'npm run start' : 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
    env: homeserverEnv,
  },
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
});