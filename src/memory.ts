/**
 * Core memory subsystem: store, search, list, get, delete, chain, supersede.
 *
 * Backed by SQLite via `bun:sqlite`. Embeddings live as JSON text in the
 * `embedding` column and are produced by `./embedder.ts`.
 */

import { Database } from "bun:sqlite";

import * as Embedder from "./embedder.js";
import * as Procedural from "./procedural.js";
import type {
  Engram,
  ListOptions,
  SearchOptions,
  StoreOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema (inlined so compiled binaries don't need a sibling .sql file)
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS engrams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  original TEXT,
  location TEXT,
  category TEXT NOT NULL DEFAULT 'fact',
  importance REAL NOT NULL DEFAULT 0.5,
  embedding TEXT NOT NULL DEFAULT '[]',
  embedding_dim INTEGER NOT NULL DEFAULT 256,
  metadata TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  project_id TEXT NOT NULL DEFAULT 'global',
  supersedes_id INTEGER REFERENCES engrams(id) ON DELETE SET NULL,
  superseded_at TEXT,
  supersession_type TEXT,
  valid_from TEXT,
  valid_until TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_engrams_category    ON engrams(category);
CREATE INDEX IF NOT EXISTS idx_engrams_project     ON engrams(project_id);
CREATE INDEX IF NOT EXISTS idx_engrams_importance  ON engrams(importance);
CREATE INDEX IF NOT EXISTS idx_engrams_created     ON engrams(created_at);
CREATE INDEX IF NOT EXISTS idx_engrams_supersedes  ON engrams(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_engrams_archived    ON engrams(archived);

CREATE TABLE IF NOT EXISTS procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ngram_df (
  ngram TEXT PRIMARY KEY,
  df    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS corpus_stats (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  total_docs  INTEGER NOT NULL DEFAULT 0
);
`;

// ---------------------------------------------------------------------------
// Row type from SQLite → camelCase Engram
// ---------------------------------------------------------------------------

type Row = {
  id: number;
  content: string;
  original: string | null;
  location: string | null;
  category: string;
  importance: number;
  embedding: string;
  embedding_dim: number;
  metadata: string;
  tags: string;
  project_id: string;
  supersedes_id: number | null;
  superseded_at: string | null;
  supersession_type: string | null;
  valid_from: string | null;
  valid_until: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
};

function rowToEngram(r: Row): Engram {
  return {
    id: r.id,
    content: r.content,
    original: r.original,
    location: r.location,
    category: r.category,
    importance: r.importance,
    embedding: JSON.parse(r.embedding) as number[],
    embedding_dim: r.embedding_dim,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    tags: JSON.parse(r.tags) as string[],
    project_id: r.project_id,
    supersedes_id: r.supersedes_id,
    superseded_at: r.superseded_at,
    supersession_type: r.supersession_type,
    valid_from: r.valid_from,
    valid_until: r.valid_until,
    archived: r.archived === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  migrateEngrams(db);
  initCorpusStats(db);
  Procedural.seedDefaults(db);
  return db;
}

/**
 * Idempotent column additions for databases created before newer schema fields.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so probe pragma_table_info.
 */
function migrateEngrams(db: Database): void {
  const cols = db
    .prepare("PRAGMA table_info(engrams)")
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("original")) {
    db.exec("ALTER TABLE engrams ADD COLUMN original TEXT");
  }
  if (!have.has("location")) {
    db.exec("ALTER TABLE engrams ADD COLUMN location TEXT");
  }
}

function initCorpusStats(db: Database): void {
  // Ensure the singleton row exists.
  db.prepare("INSERT OR IGNORE INTO corpus_stats (id, total_docs) VALUES (1, 0)").run();
}

/** Document-frequency table: { ngram → df } across the active corpus. */
function loadIdfMap(db: Database): Map<string, number> {
  initCorpusStats(db);
  const { total_docs } = db
    .prepare("SELECT total_docs FROM corpus_stats WHERE id = 1")
    .get() as { total_docs: number };
  const rows = db.prepare("SELECT ngram, df FROM ngram_df").all() as Array<{
    ngram: string;
    df: number;
  }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.ngram, Embedder.bm25Idf(r.df, total_docs));
  }
  return out;
}

/** Increment df for every n-gram in `text`, plus total_docs by 1. */
function bumpNgramDf(db: Database, text: string): void {
  const { tokenize, collectNgrams } = Embedder._internals;
  const tokens = tokenize(text);
  const ngrams = collectNgrams(tokens, 1, 3);
  const uniq = new Set(ngrams);
  const tx = db.transaction(() => {
    const upd = db.prepare(
      "INSERT INTO ngram_df (ngram, df) VALUES (?, 1) ON CONFLICT(ngram) DO UPDATE SET df = df + 1",
    );
    for (const ng of uniq) upd.run(ng);
    db.prepare("UPDATE corpus_stats SET total_docs = total_docs + 1 WHERE id = 1").run();
  });
  tx();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a memory. Returns the new id, or a `duplicate` marker when an
 * exact-content row already exists.
 */
export function store(
  db: Database,
  content: string,
  opts: StoreOptions = {},
): { ok: true; id: number } | { ok: false; reason: "duplicate" | "empty" } {
  const text = content.trim();
  if (text === "") return { ok: false, reason: "empty" };

  const existing = findByContent(db, text);
  if (existing) return { ok: false, reason: "duplicate" };

  const dims = opts.dimensions ?? Embedder.defaultDim();
  // Caller may pre-compute the vector (e.g. using the host's configured
  // embedding model). If its length differs from `dims`, we trust the caller's
  // dimension rather than truncating/padding silently.
  let embedding: number[];
  let effectiveDims: number;
  if (opts.embedding !== undefined) {
    embedding = opts.embedding;
    effectiveDims = opts.embedding.length;
  } else {
    // Hash path: weight by current corpus IDF so common n-grams stop
    // dragging unrelated documents together. We bump the document into the
    // df table FIRST and then load the map, so the new document's own
    // n-grams are present (with df=1) when we compute its embedding.
    bumpNgramDf(db, text);
    const idf = loadIdfMap(db);
    embedding = Embedder.embed(text, dims, idf);
    effectiveDims = dims;
  }
  const importance = clamp01(opts.importance ?? 0.5);
  const tags = opts.tags ?? [];
  const metadata = opts.metadata ?? {};
  const projectId = opts.project_id ?? "global";
  const validFrom = toIso(opts.valid_from ?? null);
  const validUntil = toIso(opts.valid_until ?? null);

  const stmt = db.prepare(`
    INSERT INTO engrams
      (content, original, location, category, importance, embedding, embedding_dim,
       metadata, tags, project_id, valid_from, valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    text,
    opts.original ?? null,
    opts.location ?? null,
    opts.category ?? "fact",
    importance,
    JSON.stringify(embedding),
    effectiveDims,
    JSON.stringify(metadata),
    JSON.stringify(tags),
    projectId,
    validFrom,
    validUntil,
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Cosine-similarity search. */
export function search(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): Engram[] {
  const limit = opts.limit ?? 10;
  const minSim = opts.min_similarity ?? 0;
  const category = opts.category ?? null;
  const projectId = opts.project_id ?? null;
  // Same as store(): prefer a caller-supplied query vector. If provided, the
  // server NEVER calls an embedding model on its own. Otherwise we hash-embed
  // the query using the corpus IDF map so common terms (e.g. "user", "the")
  // contribute less to similarity.
  const queryVec =
    opts.embedding ?? Embedder.embed(query, undefined, loadIdfMap(db));

  // Pull candidates. Use 5× limit or 50, whichever is greater.
  const candidateLimit = Math.max(limit * 5, 50);

  const where: string[] = ["archived = 0"];
  const params: (string | number)[] = [];

  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (projectId) {
    where.push("project_id = ?");
    params.push(projectId);
  }

  const sql = `
    SELECT * FROM engrams
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  params.push(candidateLimit);

  const rows = db.prepare(sql).all(...params) as Row[];
  const scored = rows
    .map((r) => {
      const vec = JSON.parse(r.embedding) as number[];
      return { engram: rowToEngram(r), score: Embedder.cosine(queryVec, vec) };
    })
    .filter((x) => x.score >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((x) => x.engram);
}

/** Paginated list of recent memories. */
export function list(db: Database, opts: ListOptions = {}): Engram[] {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const category = opts.category ?? null;
  const projectId = opts.project_id ?? null;
  const includeArchived = opts.include_archived ?? false;

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!includeArchived) where.push("archived = 0");
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (projectId) {
    where.push("project_id = ?");
    params.push(projectId);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT * FROM engrams
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Row[];
  return rows.map(rowToEngram);
}

/** Fetch by id. */
export function get(db: Database, id: number): Engram | null {
  const row = db.prepare("SELECT * FROM engrams WHERE id = ?").get(id) as Row | null;
  return row ? rowToEngram(row) : null;
}

/** Soft-archive (preferred over hard delete). */
export function softDelete(
  db: Database,
  id: number,
): { ok: true } | { ok: false; reason: "not_found" } {
  const info = db.prepare("UPDATE engrams SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  if (info.changes === 0) return { ok: false, reason: "not_found" };
  return { ok: true };
}

/** Hard delete. Use sparingly. */
export function destroy(
  db: Database,
  id: number,
): { ok: true } | { ok: false; reason: "not_found" } {
  const info = db.prepare("DELETE FROM engrams WHERE id = ?").run(id);
  if (info.changes === 0) return { ok: false, reason: "not_found" };
  return { ok: true };
}

/** Returns corpus statistics. */
export function stats(db: Database) {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM engrams").get() as { c: number }).c;
  const active = (
    db.prepare("SELECT COUNT(*) AS c FROM engrams WHERE archived = 0").get() as { c: number }
  ).c;
  const archived = (
    db.prepare("SELECT COUNT(*) AS c FROM engrams WHERE archived = 1").get() as { c: number }
  ).c;
  const byCategory = db
    .prepare(
      "SELECT category, COUNT(*) AS c FROM engrams WHERE archived = 0 GROUP BY category",
    )
    .all() as Array<{ category: string; c: number }>;
  return {
    total_engrams: total,
    active_engrams: active,
    archived_engrams: archived,
    by_category: Object.fromEntries(byCategory.map((r) => [r.category, r.c])),
    embedding_dim: Embedder.defaultDim(),
  };
}

/**
 * Returns the temporal chain containing `id`, oldest first.
 *
 * The chain is the linked list of engrams that point to each other via
 * `supersedes_id`. We walk up to the root, then walk down collecting every
 * descendant in insertion order.
 */
export function chain(db: Database, id: number): Engram[] | null {
  const start = get(db, id);
  if (!start) return null;
  const root = walkToRoot(db, start);
  return walkDescendants(db, root);
}

/**
 * Link `old_id` → `new_id` with the given supersession type.
 *
 * Marks `old_id` as superseded (sets `superseded_at`) and records
 * `supersedes_id` on `new_id`.
 */
export function supersede(
  db: Database,
  oldId: number,
  newId: number,
  type: string = "update",
):
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_superseded" } {
  const old = get(db, oldId);
  const next = get(db, newId);
  if (!old || !next) return { ok: false, reason: "not_found" };
  if (old.superseded_at !== null) return { ok: false, reason: "already_superseded" };

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE engrams SET superseded_at = ?, supersession_type = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(now, type, oldId);
    db.prepare(
      "UPDATE engrams SET supersedes_id = ?, supersession_type = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(oldId, type, newId);
  });
  tx();
  return { ok: true };
}

/** Find active memories at or above a given importance threshold. */
export function importanceAbove(db: Database, threshold: number, limit: number = 20): Engram[] {
  const rows = db
    .prepare(
      `SELECT * FROM engrams
       WHERE archived = 0 AND importance >= ?
       ORDER BY importance DESC, created_at DESC
       LIMIT ?`,
    )
    .all(threshold, limit) as Row[];
  return rows.map(rowToEngram);
}

/** Find memories at or below an importance threshold. */
export function decayed(db: Database, threshold: number, limit: number): Engram[] {
  const rows = db
    .prepare(
      `SELECT * FROM engrams
       WHERE archived = 0 AND importance <= ?
       ORDER BY importance ASC, created_at ASC
       LIMIT ?`,
    )
    .all(threshold, limit) as Row[];
  return rows.map(rowToEngram);
}

/**
 * Rebuild the corpus IDF table from active engrams and re-embed every engram
 * (active + archived) using the fresh weights. Use this after deleting or
 * restoring engrams in bulk, or whenever the corpus shape changes a lot.
 */
export function reindex(db: Database): { updated: number } {
  initCorpusStats(db);
  const dims = Embedder.defaultDim();

  // 1) Rebuild df from active corpus in one pass.
  db.prepare("DELETE FROM ngram_df").run();
  const activeRows = db
    .prepare("SELECT content FROM engrams WHERE archived = 0")
    .all() as Array<{ content: string }>;
  const totalDocs = activeRows.length;
  db.prepare("UPDATE corpus_stats SET total_docs = ? WHERE id = 1").run(totalDocs);

  const { tokenize, collectNgrams } = Embedder._internals;
  const df = new Map<string, number>();
  for (const r of activeRows) {
    const ngrams = collectNgrams(tokenize(r.content), 1, 3);
    for (const ng of new Set(ngrams)) df.set(ng, (df.get(ng) ?? 0) + 1);
  }
  const ins = db.prepare(
    "INSERT INTO ngram_df (ngram, df) VALUES (?, ?)",
  );
  const tx1 = db.transaction(() => {
    for (const [ngram, c] of df) ins.run(ngram, c);
  });
  tx1();

  // 2) Compute the IDF map once.
  const idf = new Map<string, number>();
  for (const [ngram, c] of df) {
    idf.set(ngram, Embedder.bm25Idf(c, totalDocs));
  }

  // 3) Re-embed every engram with fresh weights. Active rows use IDF;
  // archived rows fall back to legacy ±1 weighting because their n-grams
  // are not in the active corpus df map (would produce all-zero vectors).
  const allRows = db
    .prepare("SELECT id, content, archived FROM engrams")
    .all() as Array<{ id: number; content: string; archived: number }>;
  const upd = db.prepare(
    "UPDATE engrams SET embedding = ?, embedding_dim = ?, updated_at = datetime('now') WHERE id = ?",
  );
  let updated = 0;
  const tx2 = db.transaction(() => {
    for (const r of allRows) {
      const useIdf = r.archived === 0 ? idf : undefined;
      const v = Embedder.embed(r.content, dims, useIdf);
      upd.run(JSON.stringify(v), v.length, r.id);
      updated++;
    }
  });
  tx2();

  return { updated };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function findByContent(db: Database, content: string): Engram | null {
  const row = db
    .prepare("SELECT * FROM engrams WHERE content = ? LIMIT 1")
    .get(content) as Row | null;
  return row ? rowToEngram(row) : null;
}

function walkToRoot(db: Database, engram: Engram): Engram {
  if (engram.supersedes_id === null) return engram;
  const parent = get(db, engram.supersedes_id);
  if (!parent) return engram;
  return walkToRoot(db, parent);
}

function walkDescendants(db: Database, root: Engram): Engram[] {
  const children = db
    .prepare(
      "SELECT * FROM engrams WHERE supersedes_id = ? ORDER BY created_at ASC",
    )
    .all(root.id) as Row[];
  return [
    root,
    ...children.flatMap((r) => walkDescendants(db, rowToEngram(r))),
  ];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace(/\.\d{3}Z$/, "Z");
  return v;
}