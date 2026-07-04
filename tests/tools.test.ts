import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Tools from "../src/tools.ts";
import * as Memory from "../src/memory.ts";
import * as Procedural from "../src/procedural.ts";
import * as Embedder from "../src/embedder.ts";

let dbPath: string;
let db: ReturnType<typeof Memory.openDb>;

beforeEach(() => {
  dbPath = join(tmpdir(), `openmemory_tools_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  db = Memory.openDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }
});

describe("tools.memory", () => {
  test("store returns stored + id", () => {
    const r = Tools.memory(db, {
      operation: "store",
      content: "the project uses Postgres",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.kind).toBe("memory_store");
  });

  test("search returns query + results", () => {
    Tools.memory(db, { operation: "store", content: "we use PostgreSQL" });
    Tools.memory(db, { operation: "store", content: "we use Redis for cache" });
    const r = Tools.memory(db, { operation: "search", query: "database", limit: 5 });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "memory_search") {
      expect(r.payload.query).toBe("database");
      expect(r.payload.count).toBeGreaterThan(0);
    }
  });

  test("stats returns embedding_dim", () => {
    const r = Tools.memory(db, { operation: "stats" });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "memory_stats") {
      expect(r.payload.stats.embedding_dim).toBe(Embedder.defaultDim());
    }
  });

  test("unknown op returns error", () => {
    const r = Tools.memory(db, { operation: "blow_up" });
    expect(r.ok).toBe(false);
  });

  test("missing operation returns error", () => {
    expect(Tools.memory(db, {}).ok).toBe(false);
  });

  test("missing query in search returns error", () => {
    const r = Tools.memory(db, { operation: "search" });
    expect(r.ok).toBe(false);
  });

  test("store accepts caller-supplied embedding and preserves it", () => {
    const vec = new Array(64).fill(0);
    vec[7] = 1;
    const r = Tools.memory(db, {
      operation: "store",
      content: "GH is GitHub",
      embedding: vec,
    });
    expect(r.ok).toBe(true);
  });

  test("search uses caller-supplied query embedding", () => {
    Tools.memory(db, { operation: "store", content: "row-A", embedding: [1, 0, 0, 0] });
    Tools.memory(db, { operation: "store", content: "row-B", embedding: [0, 1, 0, 0] });
    const r = Tools.memory(db, {
      operation: "search",
      query: "anything",
      embedding: [1, 0, 0, 0],
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "memory_search") {
      expect(r.payload.results[0]!.content).toBe("row-A");
    }
  });

  test("rejects non-finite embedding values on store", () => {
    const r = Tools.memory(db, {
      operation: "store",
      content: "bad vec",
      embedding: [0, NaN, 0],
    });
    expect(r.ok).toBe(false);
  });

  test("reindex op succeeds and reports updated count", () => {
    Tools.memory(db, { operation: "store", content: "x" });
    Tools.memory(db, { operation: "store", content: "y" });
    const r = Tools.memory(db, { operation: "reindex" });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "memory_reindex") {
      expect(r.payload.updated).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("tools.ingest", () => {
  test("text mode ingests content", async () => {
    const r = await Tools.ingest(db, {
      operation: "text",
      content: "ingest me",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "ingest") {
      expect(r.payload.mode).toBe("text");
      expect(r.payload.id).toBeGreaterThan(0);
    }
  });

  test("file mode reads and ingests", async () => {
    const path = join(tmpdir(), `openmemory_ingest_${Date.now()}.txt`);
    await Bun.write(path, "file-based ingestion");
    const r = await Tools.ingest(db, {
      operation: "file",
      path,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "ingest") {
      expect(r.payload.mode).toBe("file");
      expect(r.payload.id).toBeGreaterThan(0);
    }
    try { unlinkSync(path); } catch {}
  });

  test("file with bad path returns file_read_failed", async () => {
    const r = await Tools.ingest(db, {
      operation: "file",
      path: "/no/such/path/exists",
    });
    expect(r.ok).toBe(false);
  });
});

describe("tools.procedures", () => {
  test("list returns registered procedures", () => {
    Procedural.register(db, "foo", "foo proc", [
      { action: "log" as const, message: "x" },
    ]);
    const r = Tools.procedures(db, { operation: "list" });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "procedures_list") {
      // 1 default + 1 registered
      expect(r.payload.procedures.length).toBe(2);
      expect(r.payload.procedures.find((p: { name: string }) => p.name === "foo")).toBeTruthy();
    }
  });

  test("run returns a structured trace", () => {
    Procedural.register(db, "greet", "greet", [
      { action: "log" as const, message: "hello" },
      { action: "set_context" as const, key: "ok", value: true },
    ]);
    const r = Tools.procedures(db, { operation: "run", name: "greet" });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "procedures_run") {
      expect(r.payload.result.procedure).toBe("greet");
      expect(r.payload.result.status).toBe("ok");
      expect(r.payload.result.context["ok"]).toBe(true);
    }
  });
});