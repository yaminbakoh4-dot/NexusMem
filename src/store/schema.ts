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

const V3 = `
-- A relation between two existing nodes, not a new content node -- the
-- "failure -> fix" correlation is the relationship itself, and duplicating
-- either side's content into a third node would just be another
-- independently-ranked candidate instead of the link the feature needs.
-- One physical table, multiple relation kinds; 'resolved_by' is the first.
CREATE TABLE node_links (
  from_node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  relation     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (from_node_id, to_node_id, relation)
);

-- Packing a failure node needs its resolutions; nothing needs the reverse
-- direction yet, so only the forward lookup gets an index.
CREATE INDEX idx_node_links_from ON node_links (from_node_id);
`;

const V4 = `
-- File-to-file structural relationships (currently: JS/TS import edges),
-- derived from the working tree rather than from any node's content. A
-- source file is not a node, so this cannot reuse node_links (both of its
-- columns FK to nodes.id) -- project_id has to be stored here explicitly
-- since there is no node to join through for it.
CREATE TABLE file_edges (
  project_id TEXT NOT NULL,
  from_path  TEXT NOT NULL,
  to_path    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  PRIMARY KEY (project_id, from_path, to_path, kind)
);

-- "What imports this file" (e.g. blast-radius of a change) is the query a
-- future feature needs; the primary key already covers the forward direction.
CREATE INDEX idx_file_edges_to ON file_edges (project_id, to_path);
`;

// A value-keyed complement to pruneSourceNodes' source-level deletes: entries
// here are consulted at every node-write seam (upsertNodes, reconcile.ts) so
// a matching value is skipped on ingest instead of being re-derived from an
// append-only log (shell-history.jsonl) or a full transcript re-read on the
// next sync -- see store/deny-list.ts.
const V5 = `
CREATE TABLE deny_list (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  match_type  TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  ignore_case INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_deny_list_project ON deny_list (project_id);

CREATE TABLE mutation_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  action         TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  detail         TEXT NOT NULL,
  affected_count INTEGER NOT NULL,
  succeeded      INTEGER NOT NULL,
  error          TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER NOT NULL
);
CREATE INDEX idx_mutation_audit_project ON mutation_audit (project_id, started_at DESC);

-- Hash-only: this table exists to prove a value was removed, not to retain a
-- second copy of it. body/title are stored as sha256 so the record that
-- something was forgotten never itself becomes something worth forgetting.
CREATE TABLE tombstones (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id           TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  source            TEXT NOT NULL,
  ts                TEXT NOT NULL,
  signal            REAL NOT NULL,
  body_sha256       TEXT NOT NULL,
  title_sha256      TEXT NOT NULL,
  body_length       INTEGER NOT NULL,
  deny_list_id      INTEGER NOT NULL REFERENCES deny_list (id),
  mutation_audit_id INTEGER NOT NULL REFERENCES mutation_audit (id),
  removed_at        INTEGER NOT NULL
);
CREATE INDEX idx_tombstones_project ON tombstones (project_id, removed_at DESC);
`;

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  { version: 1, up: (db) => db.exec(V1) },
  { version: 2, up: (db) => db.exec(V2) },
  { version: 3, up: (db) => db.exec(V3) },
  { version: 4, up: (db) => db.exec(V4) },
  { version: 5, up: (db) => db.exec(V5) },
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
