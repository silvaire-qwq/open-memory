import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Memory from "../src/memory.ts";
import * as Embedder from "../src/embedder.ts";

let dbPath: string;
let db: ReturnType<typeof Memory.openDb>;

beforeEach(() => {
  dbPath = join(tmpdir(), `openmemory_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  db = Memory.openDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
});

describe("memory.store", () => {
  test("stores a fact and returns an id", () => {
    const r = Memory.store(db, "the sky is blue", { category: "fact" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBeGreaterThan(0);
  });

  test("rejects empty content", () => {
    expect(Memory.store(db, "").ok).toBe(false);
    expect(Memory.store(db, "   ").ok).toBe(false);
  });

  test("detects exact-content duplicates", () => {
    const a = Memory.store(db, "duplicate me");
    const b = Memory.store(db, "duplicate me");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("duplicate");
  });

  test("stores metadata, tags, project_id", () => {
    const r = Memory.store(db, "react 19 is out", {
      category: "fact",
      importance: 0.9,
      project_id: "web",
      tags: ["react"],
      metadata: { source: "blog" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const fetched = Memory.get(db, r.id);
      expect(fetched?.category).toBe("fact");
      expect(fetched?.importance).toBeCloseTo(0.9, 6);
      expect(fetched?.project_id).toBe("web");
      expect(fetched?.tags).toEqual(["react"]);
      expect(fetched?.metadata).toEqual({ source: "blog" });
    }
  });

  test("clamps importance to 0..1", () => {
    const r1 = Memory.store(db, "high", { importance: 5 });
    const r2 = Memory.store(db, "low", { importance: -1 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) {
      const e = Memory.get(db, r1.id);
      expect(e?.importance).toBeLessThanOrEqual(1);
    }
    if (r2.ok) {
      const e = Memory.get(db, r2.id);
      expect(e?.importance).toBeGreaterThanOrEqual(0);
    }
  });

  test("accepts caller-supplied embedding and records its dim", () => {
    const vec = new Array(384).fill(0);
    vec[0] = 1;
    const r = Memory.store(db, "GH is GitHub", { embedding: vec });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const e = Memory.get(db, r.id);
      expect(e?.embedding).toEqual(vec);
      expect(e?.embedding_dim).toBe(384);
    }
  });
});

describe("memory.search", () => {
  beforeEach(() => {
    Memory.store(db, "PostgreSQL is our primary database", { category: "fact" });
    Memory.store(db, "We use React for the frontend", { category: "fact" });
    Memory.store(db, "The deployment runs on Kubernetes", { category: "fact" });
    Memory.store(db, "Pizza is the team lunch on Fridays", { category: "observation" });
  });

  test("returns matching memories ranked by similarity", () => {
    const results = Memory.search(db, "PostgreSQL database");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("PostgreSQL");
  });

  test("respects :limit", () => {
    expect(Memory.search(db, "we use", { limit: 1 }).length).toBe(1);
  });

  test("filters by :category", () => {
    const results = Memory.search(db, "we", { category: "observation" });
    for (const r of results) expect(r.category).toBe("observation");
  });

  test("filters by :min_similarity", () => {
    const results = Memory.search(db, "postgresql database", { min_similarity: 0.99 });
    expect(results.length).toBe(0);
  });

  test("uses caller-supplied query embedding for ranking", () => {
    // Two rows share no lexical n-grams with the caller's vector, but the
    // caller can still pick one by sending a vector identical to its stored
    // embedding.
    const target = new Array(8).fill(0);
    target[3] = 1;
    const decoy = new Array(8).fill(0);
    decoy[5] = 1;
    Memory.store(db, "meaningless prose for hash-only path", { embedding: target });
    Memory.store(db, "more nonsense for hash-only path", { embedding: decoy });
    const results = Memory.search(db, "ignored", { embedding: target, limit: 2 });
    expect(results.length).toBeGreaterThan(0);
    // Lexical hash says these are unrelated to "ignored", so without the
    // caller's vector, both rows would tie at 0; with the vector we should
    // rank the target row first.
    expect(Embedder.cosine(results[0]!.embedding, target)).toBeCloseTo(1, 6);
  });
});

describe("memory.list", () => {
  test("returns recent memories reverse-chronologically", () => {
    Memory.store(db, "first");
    Memory.store(db, "second");
    Memory.store(db, "third");
    const results = Memory.list(db);
    expect(results.length).toBe(3);
    expect(results[0]!.content).toBe("third");
  });

  test("paginates with limit/offset", () => {
    for (let i = 1; i <= 5; i++) Memory.store(db, `item ${i}`);
    const p1 = Memory.list(db, { limit: 2, offset: 0 });
    const p2 = Memory.list(db, { limit: 2, offset: 2 });
    expect(p1.length).toBe(2);
    expect(p2.length).toBe(2);
    const p1ids = new Set(p1.map((e) => e.id));
    for (const e of p2) expect(p1ids.has(e.id)).toBe(false);
  });

  test("excludes archived by default", () => {
    const r = Memory.store(db, "to archive");
    expect(r.ok).toBe(true);
    if (r.ok) Memory.softDelete(db, r.id);
    const def = Memory.list(db);
    expect(def.find((e) => e.id === r.id)).toBeUndefined();
    const all = Memory.list(db, { include_archived: true });
    expect(all.find((e) => e.id === r.id)).toBeDefined();
  });
});

describe("memory.softDelete", () => {
  test("archives rather than destroys", () => {
    const r = Memory.store(db, "soft delete me");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const del = Memory.softDelete(db, r.id);
    expect(del.ok).toBe(true);
    expect(Memory.list(db).find((e) => e.id === r.id)).toBeUndefined();
    expect(Memory.list(db, { include_archived: true }).find((e) => e.id === r.id)).toBeDefined();
  });

  test("returns not_found for missing id", () => {
    const r = Memory.softDelete(db, 999_999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});

describe("memory.supersede", () => {
  test("links old → new with type", () => {
    const a = Memory.store(db, "uses React 18");
    const b = Memory.store(db, "uses React 19");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const r = Memory.supersede(db, a.id, b.id, "update");
    expect(r.ok).toBe(true);
    const c = Memory.chain(db, a.id);
    expect(c?.length).toBe(2);
    expect(c?.[0]?.id).toBe(a.id);
    expect(c?.[1]?.id).toBe(b.id);
  });

  test("refuses to re-supersede", () => {
    const a = Memory.store(db, "old");
    const b = Memory.store(db, "new 1");
    const c = Memory.store(db, "new 2");
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(Memory.supersede(db, a.id, b.id, "update").ok).toBe(true);
    const r2 = Memory.supersede(db, a.id, c.id, "update");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("already_superseded");
  });

  test("returns not_found when ids don't exist", () => {
    const x = Memory.store(db, "x");
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(Memory.supersede(db, 999_999, x.id).ok).toBe(false);
    expect(Memory.supersede(db, x.id, 999_999).ok).toBe(false);
  });
});

describe("memory.chain", () => {
  test("single element for unrelated engram", () => {
    const r = Memory.store(db, "alone");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = Memory.chain(db, r.id);
    expect(c?.length).toBe(1);
    expect(c?.[0]?.id).toBe(r.id);
  });

  test("returns null for missing id", () => {
    expect(Memory.chain(db, 999_999)).toBeNull();
  });
});

describe("memory.decayed", () => {
  test("returns low-importance items", () => {
    Memory.store(db, "trivial", { importance: 0.05 });
    Memory.store(db, "important", { importance: 0.9 });
    const r = Memory.decayed(db, 0.1, 10);
    expect(r.length).toBe(1);
    expect(r[0]!.content).toBe("trivial");
  });
});

describe("memory.stats", () => {
  test("counts totals, active, archived, by category", () => {
    Memory.store(db, "a", { category: "fact" });
    Memory.store(db, "b", { category: "fact" });
    Memory.store(db, "c", { category: "rule" });
    const r = Memory.store(db, "d", { category: "rule" });
    expect(r.ok).toBe(true);
    if (r.ok) Memory.softDelete(db, r.id);

    const s = Memory.stats(db);
    expect(s.total_engrams).toBe(4);
    expect(s.active_engrams).toBe(3);
    expect(s.archived_engrams).toBe(1);
    expect(s.by_category).toEqual({ fact: 2, rule: 1 });
  });
});

describe("memory.idf weighting", () => {
  test("common stopwords stop pulling unrelated long docs together", () => {
    // Two long English docs that share many common English n-grams
    // ("user", "the", "is", "a"...). Plus one very different doc.
    Memory.store(
      db,
      "Workflow preference: the user runs a Code Wiki system per the project file layout",
    );
    Memory.store(
      db,
      "Personality note: the user self-described an extravert-to-introvert shift and the patterns observed in daily life",
    );
    Memory.store(
      db,
      "Native Chinese speaker currently a student studying computer science",
    );

    // After storing three docs, common n-grams ("user", "the") should have
    // a higher document frequency than document-specific n-grams ("wiki",
    // "code", "layout", "extravert", "introvert", "shift", "patterns").
    const idfRows = db
      .prepare("SELECT ngram, df FROM ngram_df")
      .all() as Array<{ ngram: string; df: number }>;
    const df = new Map(idfRows.map((r) => [r.ngram, r.df]));

    expect(df.get("user")).toBe(2);
    expect(df.get("the")).toBe(2);
    expect(df.get("wiki")).toBe(1);
    expect(df.get("extravert")).toBe(1);

    // IDF weighting should give rare n-grams higher weight than common ones.
    const totalDocs = 3;
    const idfUser = Embedder.bm25Idf(2, totalDocs);
    const idfWiki = Embedder.bm25Idf(1, totalDocs);
    const idfThe = Embedder.bm25Idf(2, totalDocs);
    expect(idfUser).toBeLessThan(idfWiki);
    expect(idfThe).toBeLessThan(idfWiki);
  });
});

describe("memory.reindex", () => {
  test("refreshes embeddings and reports count", () => {
    Memory.store(db, "alpha beta gamma");
    Memory.store(db, "alpha delta epsilon");
    const r = Memory.reindex(db);
    expect(r.updated).toBe(2);
  });

  test("after bulk-archive + reindex, search ranking reflects new corpus", () => {
    const a = Memory.store(db, "kubernetes deployment pipeline orchestration");
    const b = Memory.store(db, "kubernetes pod scheduling metadata");
    const c = Memory.store(db, "user pizza preference");
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    // Soft-delete the unrelated pizza engram, then reindex so the IDF
    // table stops treating "user" as corpus-wide.
    Memory.softDelete(db, c.id);
    const r = Memory.reindex(db);
    expect(r.updated).toBeGreaterThanOrEqual(3);
    const hits = Memory.search(db, "kubernetes pod", { limit: 2 });
    expect(hits[0]!.id).toBe(b.id);
  });
});