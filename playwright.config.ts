import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /production.*\.spec\.ts/,
    },
    {
      name: 'production',
      use: {
        ...devices['Desktop Chrome'],
        // Your own deployment. Never point this at someone else's server.
        baseURL: process.env.PRODUCTION_URL || 'http://localhost:3100',
      },
      testMatch: /production.*\.spec\.ts/,
      timeout: 90000,
      retries: 1,
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3100',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
