import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const storageState = process.env.E2E_STORAGE_STATE;
const storageStatePath = storageState
  ? path.isAbsolute(storageState)
    ? storageState
    : path.resolve(process.cwd(), '../..', storageState)
  : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: '../../output/playwright/test-results',
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: '../../output/playwright/report' }]]
    : 'line',
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
});
