import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The release zip is an explicit allowlist (Makefile EXTENSION_FILES). A script
// the extension loads but the list misses ships a broken build, and no other
// test notices because tests load the unpacked folder.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(root, f), 'utf8');

function zipFiles() {
  const m = read('Makefile').match(/EXTENSION_FILES := \\\n([\s\S]*?)\n\n/);
  return new Set(m[1].replace(/\\/g, ' ').split(/\s+/).filter(Boolean));
}

test('every file the extension loads is in the release zip', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pageAssets = page => [...read(page).matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map(m => m[1]);
  const accessible = (manifest.web_accessible_resources || []).flatMap(r => r.resources);
  const loaded = new Set([
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(cs => cs.js),
    ...accessible,
    ...['popup.html', ...accessible.filter(f => f.endsWith('.html'))].flatMap(pageAssets),
    ...[...read('background.js').match(/importScripts\(([\s\S]*?)\);/)[1]
      .replace(/\/\/.*$/gm, '') // comments may contain quotes
      .matchAll(/'([^']+)'/g)].map(m => m[1]),
  ]);
  const zip = zipFiles();
  expect([...loaded].filter(f => !zip.has(f))).toEqual([]);
});
