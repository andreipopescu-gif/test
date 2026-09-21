// Takes a compressed logical backup of the SaaS database with pg_dump.
//
// The hosting provider's own snapshots are not a backup strategy on their own:
// the free PostgreSQL plan has none, and a provider-held snapshot disappears
// with the provider account. This script needs nothing but pg_dump and a
// writable directory, so it works from a laptop, a cron job or a CI runner.
//
//   DATABASE_URL=postgresql://... node scripts/backup.js
//   DATABASE_URL=postgresql://... BACKUP_DIR=/mnt/backups node scripts/backup.js
//
// Restore into a scratch database and verify before trusting a file:
//   createdb itinv_restore_check
//   pg_restore --dbname=postgresql://.../itinv_restore_check --no-owner <file>
//   TEST_DATABASE_URL=postgresql://.../itinv_restore_check npm run test:postgres

import { spawn } from 'node:child_process';
import { mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is required. Point it at the database you want to back up.');
}

const backupDir = resolve(process.env.BACKUP_DIR || 'backups');
const retainDays = Number(process.env.BACKUP_RETAIN_DAYS || 30);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(backupDir, `it-inventory-saas-${stamp}.dump`);

await mkdir(backupDir, { recursive: true });
log(`Dumping to ${target}`);

// Custom format so a single file can be restored selectively with pg_restore.
await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${target}`, databaseUrl]);

const { size } = await stat(target);
if (size < 1_024) fail(`Dump is only ${size} bytes; treating it as failed.`);
log(`Wrote ${(size / 1_024 / 1_024).toFixed(2)} MB`);

// A dump that cannot be listed cannot be restored, so verify before pruning.
await run('pg_restore', ['--list', target], { quiet: true });
log('Verified the dump table of contents');

const removed = await prune();
if (removed.length) log(`Removed ${removed.length} backup(s) older than ${retainDays} days`);
log('Backup complete');

async function prune() {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return [];
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1_000;
  const removed = [];
  for (const name of await readdir(backupDir)) {
    if (!name.startsWith('it-inventory-saas-') || !name.endsWith('.dump')) continue;
    const path = join(backupDir, name);
    if (path === target) continue;
    const info = await stat(path);
    if (info.mtimeMs < cutoff) {
      await unlink(path);
      removed.push(name);
    }
  }
  return removed;
}

function run(command, args, { quiet = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit' });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') fail(`${command} is not installed or not on PATH.`);
      fail(`${command} failed: ${error.message}`);
    });
    child.on('exit', (code) => {
      if (code !== 0) fail(`${command} exited with code ${code}. ${stderr.trim()}`);
      resolvePromise();
    });
  });
}

function log(message) {
  console.log(`[backup] ${message}`);
}

function fail(message) {
  console.error(`[backup] FAILED: ${message}`);
  process.exit(1);
}
