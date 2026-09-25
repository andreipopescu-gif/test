// Applies per-organization retention: drop stale import previews / batches,
// scrub applied import payloads, and prune old audit rows.
//
// Free to run from a laptop cron, Render free cron, or GitHub Actions:
//   node scripts/retention-cleanup.js
//   SAAS_DB_PATH=./data/saas.sqlite node scripts/retention-cleanup.js
//   DATABASE_URL=postgresql://... node scripts/retention-cleanup.js

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { runRetentionCleanup } from '../src/privacy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SAAS_DB_PATH || join(__dirname, '..', 'data', 'saas.sqlite');

const db = await openDatabase({
  databaseUrl: process.env.DATABASE_URL,
  dbPath
});

try {
  const summary = await runRetentionCleanup(db);
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
} finally {
  await db.close?.();
}
