// Browser end-to-end tests (Chromium) against the built sites + real sales servers.
// Run: pnpm build && pnpm test:e2e
import { defineConfig, devices } from '@playwright/test';

const chromium = process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {};

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/e2e-artifacts', // keep node-junit.xml: Playwright empties its outputDir on start
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'test-results/e2e-report', open: 'never' }], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ...chromium },
  webServer: { command: 'node tests/e2e/start-stack.mjs', url: 'http://127.0.0.1:4312/', reuseExistingServer: !process.env.CI, timeout: 30_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chromium } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...chromium }, grep: /@mobile/ },
  ],
});
