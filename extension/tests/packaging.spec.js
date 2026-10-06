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

test('every script the extension loads is in the release zip', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const loaded = new Set([
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(cs => cs.js),
    ...[...read('popup.html').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]),
    ...[...read('background.js').match(/importScripts\(([\s\S]*?)\);/)[1]
      .replace(/\/\/.*$/gm, '') // comments may contain quotes
      .matchAll(/'([^']+)'/g)].map(m => m[1]),
  ]);
  const zip = zipFiles();
  expect([...loaded].filter(f => !zip.has(f))).toEqual([]);
});
