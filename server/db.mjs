import pg from "pg";

export async function createPool(config) {
  if (!config) return null;
  const pool = new pg.Pool(config);
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return pool;
  } catch (err) {
    console.error("Postgres connection failed:", err.message);
    await pool.end().catch(() => {});
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id    TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  data  JSONB NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_entities_collection ON entities(collection);
`;

export async function initSchema(pool) {
  await pool.query(SCHEMA);
}
