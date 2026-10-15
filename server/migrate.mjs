import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = resolve(ROOT, 'db/migrations');

async function migrate() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required before production startup.');
    console.log('No DATABASE_URL configured; skipping persistent database migrations for local memory mode.');
    return;
  }
  const files = (await readdir(MIGRATIONS)).filter((name) => /^\d+_[a-zA-Z0-9_-]+\.sql$/.test(name)).sort();
  const pool = new Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS mintchat_schema_migrations (migration_id VARCHAR(180) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['mintchat_schema_migrations']);
    for (const file of files) {
      const source = await readFile(resolve(MIGRATIONS, file), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const { rows } = await client.query('SELECT checksum FROM mintchat_schema_migrations WHERE migration_id = $1', [file]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} has changed; add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(source);
        await client.query('INSERT INTO mintchat_schema_migrations (migration_id, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        console.log(`Applied ${file}`);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['mintchat_schema_migrations']).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`Database migration failed: ${String(error?.message || 'unknown error').slice(0, 300)}`);
  process.exitCode = 1;
});
