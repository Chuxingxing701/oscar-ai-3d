import {defineConfig, devices} from '@playwright/test';

// Browser acceptance against a REAL Runtime + Agent started by global-setup
// in an isolated temp data dir. Chromium is installed with
// `npx playwright install chromium` (see README).
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: {timeout: 20_000},
  reporter: [['list'], ['json', {outputFile: '../../reports/e2e/results.json'}]],
  outputDir: '../../test-results/e2e',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']},
  },
  projects: [
    {name: 'desktop', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}},
      testIgnore: /mobile\.spec\.ts$/},
    {name: 'mobile', use: {...devices['Desktop Chrome'], viewport: {width: 390, height: 844}, isMobile: false, hasTouch: true},
      testMatch: /mobile\.spec\.ts$/},
  ],
});
