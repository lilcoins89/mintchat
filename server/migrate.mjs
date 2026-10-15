import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

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
  const pool = mysql.createPool(url);
  const connection = await pool.getConnection();
  let lockAcquired = false;
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS mintchat_schema_migrations (
        migration_id VARCHAR(180) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [lockRows] = await connection.query("SELECT GET_LOCK('mintchat_schema_migrations', 30) AS acquired");
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error('Could not obtain the database migration lock within 30 seconds.');

    for (const file of files) {
      const source = await readFile(resolve(MIGRATIONS, file), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const [rows] = await connection.execute('SELECT checksum FROM mintchat_schema_migrations WHERE migration_id = ?', [file]);
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} has changed; add a new migration instead.`);
        continue;
      }
      const statements = source.split(';').map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await connection.query(statement);
      await connection.execute('INSERT INTO mintchat_schema_migrations (migration_id, checksum) VALUES (?, ?)', [file, checksum]);
      console.log(`Applied ${file}`);
    }
  } finally {
    if (lockAcquired) await connection.query("SELECT RELEASE_LOCK('mintchat_schema_migrations')").catch(() => undefined);
    connection.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`Database migration failed: ${String(error?.message || 'unknown error').slice(0, 300)}`);
  process.exitCode = 1;
});
