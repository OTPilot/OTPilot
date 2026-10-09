// Store screenshots only (see screenshots.spec.js); not part of the test suite.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.js',
  workers: 1,
  use: { headless: false },
  webServer: {
    command: 'python3 -m http.server 8765',
    url: 'http://localhost:8765',
    reuseExistingServer: true,
    cwd: path.resolve(__dirname, '..'),
  },
});
