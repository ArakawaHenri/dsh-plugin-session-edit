import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildClientSource } from './build-client.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(file);
  }
  return files;
}

const files = [resolve(root, 'index.js'), resolve(root, 'remote.js'), resolve(root, 'client.js')];
for (const dir of ['lib', 'src', 'scripts', 'test']) {
  files.push(...(await filesIn(resolve(root, dir))));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${file}\n${result.stderr || result.error || 'Syntax check failed'}`);
  }
}

assert.equal(
  await readFile(resolve(root, 'client.js'), 'utf8'),
  await buildClientSource(),
  'Generated client.js is stale; run npm run build',
);

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.engines.dsh, '0.2.1-rc.2');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');

console.log(`Checked ${files.length} JavaScript files, client bundle, locale keys, and package metadata.`);
