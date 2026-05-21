import { copyFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export default async function globalSetup() {
  const config     = path.join(root, 'config.js');
  const testConfig = path.join(root, 'config.test.js');
  const backup     = path.join(root, 'config.js.bak');

  if (existsSync(config) && !existsSync(backup)) copyFileSync(config, backup);
  copyFileSync(testConfig, config);
}
