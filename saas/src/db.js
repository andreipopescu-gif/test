import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresMigrations, sqliteMigrations } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(__dirname, '..', 'data', 'saas.sqlite');

export async function openDatabase(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl) return openPostgres(databaseUrl);
  return openSqlite(options.dbPath || process.env.SAAS_DB_PATH || defaultPath);
}

async function openSqlite(dbPath) {
  // Imported lazily: node:sqlite is unavailable on Node builds without the
  // experimental flag, and Postgres deployments must not depend on it.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('SQLite is unavailable on this Node build. Set DATABASE_URL to use PostgreSQL.');
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON;');
  const adapter = {
    dialect: 'sqlite',
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const result = raw.prepare(sql).run(...params);
      return { changes: Number(result.changes || 0) };
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async transaction(callback) {
      raw.exec('BEGIN');
      try {
        const result = await callback(adapter);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    async ping() {
      raw.prepare('SELECT 1').get();
      return true;
    },
    async close() {
      raw.close();
    }
  };
  await migrate(adapter, sqliteMigrations);
  return adapter;
}

async function openPostgres(databaseUrl) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error('PostgreSQL requires the "pg" package. Run npm install in saas/.');
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
    max: Number(process.env.DATABASE_POOL_MAX || 10)
  });

  const createAdapter = (client = pool) => ({
    dialect: 'postgres',
    async get(sql, params = []) {
      const result = await client.query(postgresSql(sql), params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await client.query(postgresSql(sql), params);
      return result.rows;
    },
    async run(sql, params = []) {
      const result = await client.query(postgresSql(sql), params);
      return { changes: Number(result.rowCount || 0) };
    },
    async exec(sql) {
      await client.query(sql);
    },
    async ping() {
      await client.query('SELECT 1');
      return true;
    }
  });
  const adapter = createAdapter();
  adapter.transaction = async (callback) => {
    const client = await pool.connect();
    const tx = createAdapter(client);
    try {
      await client.query('BEGIN');
      const result = await callback(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  adapter.close = () => pool.end();
  await withMigrationLock(pool, () => migrate(adapter, postgresMigrations));
  return adapter;
}

// Migrations run inside the web process on boot, so two instances starting
// together would otherwise apply the same version concurrently. The lock is
// session-scoped, which means it has to be held on one dedicated connection
// rather than on the pool.
async function withMigrationLock(pool, run) {
  const lockKey = `hashtext('it_inventory_migrations')`;
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${lockKey})`);
    return await run();
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(${lockKey})`);
    } finally {
      client.release();
    }
  }
}

async function migrate(db, migrations) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    (await db.all('SELECT version FROM schema_migrations')).map((row) => Number(row.version))
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        [migration.version, new Date().toISOString()]
      );
    });
    applied.add(migration.version);
  }
}

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
