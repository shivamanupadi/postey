#!/usr/bin/env node
/**
 * Upload installer/dist to the postey-releases R2 bucket under current/.
 *
 *   node installer/upload-release.mjs           # remote bucket (wrangler auth)
 *   node installer/upload-release.mjs --local   # local dev bucket for
 *                                               # `wrangler dev` of home-api
 *
 * Assets are hash-addressed (immutable); manifest.json is uploaded last so a
 * concurrent deploy never sees a manifest that references missing artifacts.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'installer/dist');
const HOME_API = path.join(ROOT, 'apps/home/api');
const LOCAL = process.argv.includes('--local');
const BUCKET = 'postey-releases';

function put(key, filePath) {
  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    `${BUCKET}/${key}`,
    `--file=${filePath}`,
    ...(LOCAL ? ['--local', '--persist-to', path.join(HOME_API, '.wrangler/state')] : ['--remote']),
  ];
  const res = spawnSync('bunx', args, { cwd: HOME_API, stdio: 'pipe' });
  if (res.status !== 0) {
    console.error(`✗ upload failed for ${key}\n${res.stderr}`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
console.log(`==> Uploading release v${manifest.version} (${LOCAL ? 'local' : 'remote'})`);

for (const worker of ['api-worker.js', 'send-worker.js', 'inbound-worker.js']) {
  put(`current/${worker}`, path.join(DIST, worker));
  console.log(`  current/${worker}`);
}
const assets = readdirSync(path.join(DIST, 'assets'));
for (const hash of assets) {
  put(`current/assets/${hash}`, path.join(DIST, 'assets', hash));
}
console.log(`  ${assets.length} assets`);
for (const m of manifest.migrations) {
  put(`current/migrations/${m}`, path.join(DIST, 'migrations', m));
  console.log(`  current/migrations/${m}`);
}
put('current/manifest.json', path.join(DIST, 'manifest.json'));
console.log('  current/manifest.json');
console.log('\n✓ Release published');
