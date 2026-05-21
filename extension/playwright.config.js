import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  globalSetup:    './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',
  // Extensions require headed Chrome; use --headless=new for CI
  use: {
    headless: false,
  },
  webServer: {
    command: 'python3 -m http.server 8765',
    url: 'http://localhost:8765',
    reuseExistingServer: !process.env.CI,
    cwd: __dirname,
  },
});
