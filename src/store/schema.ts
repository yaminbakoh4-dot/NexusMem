import type { Database } from 'better-sqlite3';

/**
 * Schema migrations, applied in order and tracked via `PRAGMA user_version`.
 *
 * Migrations are append-only: never edit a shipped migration, add a new one.
 */

const V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  root           TEXT NOT NULL,
  origin_url     TEXT,
  created_at     INTEGER NOT NULL,
  last_synced_at INTEGER
);

CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- Human-readable ISO-8601 with offset, kept verbatim from the source event.
  ts         TEXT NOT NULL,
  -- Same instant as epoch ms, so range scans and ordering never parse strings.
  ts_epoch   INTEGER NOT NULL,
  source     TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  signal     REAL NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_nodes_project_ts   ON nodes (project_id, ts_epoch DESC);
CREATE INDEX idx_nodes_project_kind ON nodes (project_id, kind, ts_epoch DESC);

CREATE TABLE node_files (
  node_id       TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  previous_path TEXT,
  insertions    INTEGER,
  deletions     INTEGER,
  is_binary     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, path)
);

-- Path-scoped recall ("what happened to src/store/db.ts?") is a first-class
-- query, so it gets its own index rather than a scan over node_files.
CREATE INDEX idx_node_files_path ON node_files (path);

-- External-content FTS: the index stores no copy of the text, it points back
-- at nodes.rowid. Halves the on-disk footprint of the searchable corpus.
CREATE VIRTUAL TABLE nodes_fts USING fts5 (
  title,
  body,
  content = 'nodes',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO nodes_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE sync_state (
  project_id  TEXT NOT NULL,
  -- Collector identity, e.g. 'git' or 'shell:pwsh'.
  source      TEXT NOT NULL,
  -- Opaque to the store; for git this is the HEAD sha at last successful sync.
  cursor      TEXT,
  last_run_at INTEGER,
  PRIMARY KEY (project_id, source)
);
`;

/**
 * nomic-embed-text produces 768-dimensional vectors (confirmed against a
 * live Ollama call, not assumed). `vec0` fixes a table's dimension at
 * creation time, so switching embedding models later means a new
 * migration and a re-embed, not an in-place change to this one.
 */
export const EMBEDDING_DIM = 768;

const V2 = `
-- Unlike nodes_fts, this is NOT trigger-populated: computing an embedding
-- means an async call to an external model, which a synchronous SQL trigger
-- cannot make. Rows are written explicitly by the embedding pass in
-- vector/embed.ts, keyed by the same rowid nodes_fts already uses.
CREATE VIRTUAL TABLE nodes_vec USING vec0 (
  embedding float[${EMBEDDING_DIM}]
);
`;

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  { version: 1, up: (db) => db.exec(V1) },
  { version: 2, up: (db) => db.exec(V2) },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function currentSchemaVersion(db: Database): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

export function migrate(db: Database): { from: number; to: number } {
  const from = currentSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  return { from, to: currentSchemaVersion(db) };
}
