// Demo videos: one recorded video per website page, per admin page and per feature walkthrough, with on-screen
// captions. Run: pnpm build && pnpm test:demo  → test-results/demo/index.html (built by scripts/demo-index.mjs).
import { defineConfig, devices } from '@playwright/test';

const chromium = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: 'tests/demo',
  outputDir: 'test-results/demo-artifacts',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/demo-report.json' }], ['junit', { outputFile: 'test-results/demo-junit.xml' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { slowMo: Number(process.env.DEMO_SLOWMO || 120), ...chromium },
  },
  webServer: { command: 'node tests/e2e/start-stack.mjs', url: 'http://127.0.0.1:4312/', reuseExistingServer: !process.env.CI, timeout: 30_000 },
  projects: [{ name: 'demo' }],
});
