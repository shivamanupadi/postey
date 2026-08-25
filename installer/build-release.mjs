#!/usr/bin/env node
/**
 * Build the release artifacts the postey.app/deploy wizard provisions from:
 * prebuilt worker bundles (api, send, inbound), the dashboard web dist, and
 * D1 migrations.
 *
 *   node installer/build-release.mjs
 *
 * Output: installer/dist/{api-worker.js,send-worker.js,inbound-worker.js,
 * assets/, migrations/, manifest.json}. Worker bundles come from
 * `wrangler deploy --dry-run --outdir` (the same esbuild pipeline a real
 * deploy uses). Upload with installer/upload-release.mjs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'installer/dist');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function run(cmd, args, cwd = ROOT) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} failed`);
    process.exit(1);
  }
}

function bundleWorker(app, outName) {
  const outdir = path.join(DIST, `.${outName}`);
  run('bunx', ['wrangler', 'deploy', '--dry-run', `--outdir=${outdir}`], path.join(ROOT, 'apps', app));
  const js = readdirSync(outdir).find(f => f.endsWith('.js'));
  if (!js) {
    console.error(`✗ no bundle produced for ${app}`);
    process.exit(1);
  }
  copyFileSync(path.join(outdir, js), path.join(DIST, `${outName}.js`));
  rmSync(outdir, { recursive: true, force: true });
  console.log(
    `  dist/${outName}.js (${(statSync(path.join(DIST, `${outName}.js`)).size / 1024).toFixed(0)} KB)`
  );
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
};

function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

console.log('==> Cleaning');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log('==> Building dashboard web');
run('bun', ['run', '--cwd', 'apps/platform/web', 'build']);
const webDist = path.join(ROOT, 'apps/platform/web/dist');

console.log('==> Bundling workers');
bundleWorker('platform/api', 'api-worker');
bundleWorker('platform/send', 'send-worker');
bundleWorker('platform/inbound', 'inbound-worker');

console.log('==> Hashing web assets');
mkdirSync(path.join(DIST, 'assets'), { recursive: true });
const assets = [];
for (const rel of walk(webDist)) {
  const abs = path.join(webDist, rel);
  const content = readFileSync(abs);
  // Workers assets manifest hash: first 32 hex chars of SHA-256 over content+path.
  const hash = createHash('sha256')
    .update(content)
    .update(rel)
    .digest('hex')
    .slice(0, 32);
  writeFileSync(path.join(DIST, 'assets', hash), content);
  assets.push({
    path: rel,
    hash,
    size: content.length,
    contentType: CONTENT_TYPES[path.extname(rel)] ?? null,
  });
}
console.log(`  ${assets.length} assets`);

console.log('==> Migrations');
mkdirSync(path.join(DIST, 'migrations'), { recursive: true });
const migrationsDir = path.join(ROOT, 'apps/platform/api/src/db/migrations');
const migrations = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();
for (const f of migrations) {
  copyFileSync(path.join(migrationsDir, f), path.join(DIST, 'migrations', f));
}

writeFileSync(
  path.join(DIST, 'manifest.json'),
  JSON.stringify({ version: VERSION, uploadedAt: new Date().toISOString(), assets, migrations }, null, 2)
);

console.log(`\n✓ Release v${VERSION} built at installer/dist - upload with:`);
console.log('  node installer/upload-release.mjs [--local]');
