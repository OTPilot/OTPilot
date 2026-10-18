// vite-react-ssg 0.9.x imports react-router-dom/server.js, which react-router 7
// no longer has; v7 exports the same three functions from react-router-dom
// itself. Runs after every install (postinstall); a no-op once patched, and a
// failure when the import isn't found (a new vite-react-ssg: check the patch is
// still needed, then remove it).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'node_modules', 'vite-react-ssg', 'dist', 'shared');
const FROM = "await import('react-router-dom/server.js')";
const TO = "await import('react-router-dom')";
let patched = 0;
for (const name of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
  const file = join(dir, name);
  const src = readFileSync(file, 'utf8');
  if (src.includes(FROM)) writeFileSync(file, src.replaceAll(FROM, TO));
  if (src.includes(FROM) || src.includes(TO)) patched++;
}
if (!patched) {
  console.error('patch-vite-react-ssg: the react-router-dom/server.js import was not found');
  process.exit(1);
}
