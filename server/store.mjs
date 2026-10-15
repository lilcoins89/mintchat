import mysql from 'mysql2/promise';

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
  constructor() {
    this.sessions = new Map();
    this.audit = [];
    this.locks = new Map();
  }

  async init() {}

  async loadSession(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, defaultSessionState());
    const state = normalizeState(this.sessions.get(id));
    this.sessions.set(id, state);
    return structuredClone(state);
  }

  async saveSession(id, state) {
    const normalized = normalizeState(state);
    this.sessions.set(id, structuredClone(normalized));
    return structuredClone(normalized);
  }

  async mutateSession(id, updater) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try {
      const state = await this.loadSession(id);
      const result = await updater(state);
      await this.saveSession(id, state);
      return { state: structuredClone(state), result };
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  async logToolCall(entry) {
    this.audit.push({ ...entry, createdAt: new Date().toISOString() });
    if (this.audit.length > 2000) this.audit.shift();
  }

  async close() {}
}

export class MysqlStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    const [rows] = await this.pool.execute('SELECT migration_id FROM mintchat_schema_migrations WHERE migration_id = ?', ['001_initial.sql']);
    if (!rows.length) throw new Error('Database schema is not prepared; run pnpm db:migrate before starting the app.');
  }

  async ensureSession(connection, id) {
    await connection.execute(
      'INSERT IGNORE INTO mintchat_sessions (session_id, state_json) VALUES (?, ?)',
      [id, JSON.stringify(defaultSessionState())],
    );
  }

  async loadSession(id) {
    const [rows] = await this.pool.execute('SELECT state_json FROM mintchat_sessions WHERE session_id = ?', [id]);
    if (!rows.length) {
      const state = defaultSessionState();
      await this.pool.execute('INSERT IGNORE INTO mintchat_sessions (session_id, state_json) VALUES (?, ?)', [id, JSON.stringify(state)]);
      return state;
    }
    let state;
    try {
      state = JSON.parse(rows[0].state_json);
    } catch {
      state = defaultSessionState();
    }
    const normalized = normalizeState(state);
    if (normalized.dailyDate !== state.dailyDate) await this.saveSession(id, normalized);
    return normalized;
  }

  async saveSession(id, state) {
    const normalized = normalizeState(state);
    await this.pool.execute(
      `INSERT INTO mintchat_sessions (session_id, state_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)`,
      [id, JSON.stringify(normalized)],
    );
    return normalized;
  }

  async mutateSession(id, updater) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.ensureSession(connection, id);
      const [rows] = await connection.execute('SELECT state_json FROM mintchat_sessions WHERE session_id = ? FOR UPDATE', [id]);
      let loaded;
      try {
        loaded = JSON.parse(rows[0].state_json);
      } catch {
        loaded = defaultSessionState();
      }
      const state = normalizeState(loaded);
      const result = await updater(state);
      await connection.execute('UPDATE mintchat_sessions SET state_json = ? WHERE session_id = ?', [JSON.stringify(state), id]);
      await connection.commit();
      return { state: structuredClone(state), result };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async logToolCall(entry) {
    const detail = JSON.stringify(entry.details ?? {}).slice(0, 4000);
    await this.pool.execute(
      'INSERT INTO mintchat_tool_audit (session_id, plugin_name, tool_name, outcome, detail_json) VALUES (?, ?, ?, ?, ?)',
      [entry.sessionId, entry.plugin, entry.tool, entry.outcome, detail],
    );
  }

  async close() {
    await this.pool.end();
  }
}

export async function createStore(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required for persistent production sessions.');
    return new MemoryStore();
  }
  const pool = mysql.createPool(databaseUrl);
  const store = new MysqlStore(pool);
  await store.init();
  return store;
}
