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
  reporter: [['list'], ['html', { outputFolder: 'test-results/e2e-report', open: 'never' }], ['junit', { outputFile: 'test-results/e2e-junit.xml' }], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  // E2E_VIDEO=1 (CI) records every flow; the videos go into the demo bundle (scripts/demo-index.mjs)
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: process.env.E2E_VIDEO ? 'on' : 'off', ...chromium },
  // E2E_EXTERNAL=1: the sites are already running (scripts/prod-stack.sh — production Docker image behind Caddy)
  webServer: process.env.E2E_EXTERNAL ? undefined : { command: 'node tests/e2e/start-stack.mjs', url: 'http://127.0.0.1:4312/', reuseExistingServer: !process.env.CI, timeout: 30_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chromium } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...chromium }, grep: /@mobile/ },
  ],
});
