import { copyFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export default async function globalTeardown() {
  const config = path.join(root, 'config.js');
  const backup = path.join(root, 'config.js.bak');

  if (existsSync(backup)) {
    copyFileSync(backup, config);
    unlinkSync(backup);
  }
}
