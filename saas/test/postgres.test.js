import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';

// Only SQLite is exercised by default, so the Postgres branch of db.js — the
// `?` to `$n` rewrite, the transaction client and the migration lock — went
// untested until a deploy. Set TEST_DATABASE_URL to cover it.
const databaseUrl = process.env.TEST_DATABASE_URL;
const options = { skip: databaseUrl ? false : 'TEST_DATABASE_URL is not set' };

test('postgres applies migrations and round-trips parameters', options, async () => {
  const db = await openDatabase({ databaseUrl });
  try {
    const versions = (await db.all('SELECT version FROM schema_migrations ORDER BY version'))
      .map((row) => Number(row.version));
    assert.ok(versions.length > 0);
    assert.equal(new Set(versions).size, versions.length);

    const id = randomUUID();
    await db.run(
      'INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
      [id, 'Postgres Co', `postgres-co-${id.slice(0, 8)}`, new Date().toISOString()]
    );
    const found = await db.get('SELECT name FROM organizations WHERE id = ?', [id]);
    assert.equal(found.name, 'Postgres Co');

    await db.run('DELETE FROM organizations WHERE id = ?', [id]);
    assert.equal(await db.get('SELECT id FROM organizations WHERE id = ?', [id]), undefined);
  } finally {
    await db.close();
  }
});

test('a failed transaction leaves nothing behind', options, async () => {
  const db = await openDatabase({ databaseUrl });
  const id = randomUUID();
  try {
    await assert.rejects(db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
        [id, 'Rollback Co', `rollback-co-${id.slice(0, 8)}`, new Date().toISOString()]
      );
      throw new Error('forced rollback');
    }));
    assert.equal(await db.get('SELECT id FROM organizations WHERE id = ?', [id]), undefined);
  } finally {
    await db.close();
  }
});

// Two instances booting at once must not apply the same migration twice.
test('concurrent boots serialize on the migration lock', options, async () => {
  const [first, second] = await Promise.all([
    openDatabase({ databaseUrl }),
    openDatabase({ databaseUrl })
  ]);
  try {
    const versions = (await first.all('SELECT version FROM schema_migrations ORDER BY version'))
      .map((row) => Number(row.version));
    assert.equal(new Set(versions).size, versions.length);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
