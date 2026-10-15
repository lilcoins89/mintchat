import pg from 'pg';

const { Pool } = pg;

export function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

export function defaultSessionState() {
  return {
    history: [],
    tradingUnlocked: false,
    dailyDate: utcDay(),
    dailySpentUsd: 0,
    pendingApproval: null,
    requests: [],
    walletAddress: null,
  };
}

function normalizeState(state) {
  const base = { ...defaultSessionState(), ...(state ?? {}) };
  if (typeof base.dailyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(base.dailyDate)) {
    base.dailyDate = utcDay();
    base.dailySpentUsd = -1;
  } else if (base.dailyDate !== utcDay()) {
    base.dailyDate = utcDay();
    base.dailySpentUsd = 0;
  }
  if (typeof base.dailySpentUsd !== 'number' || !Number.isFinite(base.dailySpentUsd) || base.dailySpentUsd < 0) base.dailySpentUsd = -1;
  base.history = Array.isArray(base.history) ? base.history.slice(-60) : [];
  base.requests = Array.isArray(base.requests) ? base.requests.slice(-20) : [];
  return base;
}

export class MemoryStore {
  constructor() { this.sessions = new Map(); this.audit = []; this.locks = new Map(); }
  async init() {}
  async loadSession(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, defaultSessionState());
    const state = normalizeState(this.sessions.get(id));
    this.sessions.set(id, state);
    return structuredClone(state);
  }
  async saveSession(id, state) { const normalized = normalizeState(state); this.sessions.set(id, structuredClone(normalized)); return structuredClone(normalized); }
  async mutateSession(id, updater) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try { const state = await this.loadSession(id); const result = await updater(state); await this.saveSession(id, state); return { state: structuredClone(state), result }; }
    finally { release(); if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  async logToolCall(entry) { this.audit.push({ ...entry, createdAt: new Date().toISOString() }); if (this.audit.length > 2000) this.audit.shift(); }
  async close() {}
}

export class PostgresStore {
  constructor(pool) { this.pool = pool; }
  async init() {
    const { rows } = await this.pool.query('SELECT migration_id FROM mintchat_schema_migrations WHERE migration_id = $1', ['001_initial.sql']);
    if (!rows.length) throw new Error('Database schema is not prepared; run pnpm db:migrate before starting the app.');
  }
  async loadSession(id) {
    const { rows } = await this.pool.query('SELECT state_json FROM mintchat_sessions WHERE session_id = $1', [id]);
    if (!rows.length) { const state = defaultSessionState(); await this.pool.query('INSERT INTO mintchat_sessions (session_id, state_json) VALUES ($1, $2::jsonb) ON CONFLICT (session_id) DO NOTHING', [id, JSON.stringify(state)]); return state; }
    const normalized = normalizeState(rows[0].state_json);
    if (normalized.dailyDate !== rows[0].state_json.dailyDate) await this.saveSession(id, normalized);
    return normalized;
  }
  async saveSession(id, state) {
    const normalized = normalizeState(state);
    await this.pool.query('INSERT INTO mintchat_sessions (session_id, state_json) VALUES ($1, $2::jsonb) ON CONFLICT (session_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()', [id, JSON.stringify(normalized)]);
    return normalized;
  }
  async mutateSession(id, updater) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seed = defaultSessionState();
      await client.query('INSERT INTO mintchat_sessions (session_id, state_json) VALUES ($1, $2::jsonb) ON CONFLICT (session_id) DO NOTHING', [id, JSON.stringify(seed)]);
      const { rows } = await client.query('SELECT state_json FROM mintchat_sessions WHERE session_id = $1 FOR UPDATE', [id]);
      const state = normalizeState(rows[0].state_json);
      const result = await updater(state);
      await client.query('UPDATE mintchat_sessions SET state_json = $1::jsonb, updated_at = NOW() WHERE session_id = $2', [JSON.stringify(state), id]);
      await client.query('COMMIT');
      return { state: structuredClone(state), result };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async logToolCall(entry) {
    await this.pool.query('INSERT INTO mintchat_tool_audit (session_id, plugin_name, tool_name, outcome, detail_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [entry.sessionId, entry.plugin, entry.tool, entry.outcome, JSON.stringify(entry.details ?? {}).slice(0, 4000)]);
  }
  async close() { await this.pool.end(); }
}

export async function createStore(env = process.env) {
  if (!env.DATABASE_URL) {
    if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required for persistent production sessions.');
    return new MemoryStore();
  }
  const store = new PostgresStore(new Pool({ connectionString: env.DATABASE_URL, max: 5 }));
  await store.init();
  return store;
}

export { normalizeState };
