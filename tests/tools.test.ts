import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as Tools from "../src/tools.ts";
import * as Memory from "../src/memory.ts";
import * as Procedural from "../src/procedural.ts";
import * as Embedder from "../src/embedder.ts";
import * as Originals from "../src/originals.ts";

let dbPath: string;
let originalsDir: string;
let db: ReturnType<typeof Memory.openDb>;

beforeEach(async () => {
  dbPath = join(tmpdir(), `openmemory_tools_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  originalsDir = join(tmpdir(), `openmemory_orig_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  process.env.OPENMEMORY_ORIGINALS_DIR = originalsDir;
  db = Memory.openDb(dbPath);
  await Memory.runMigrations(db);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) try { rmSync(p, { force: true }); } catch {}
  }
  if (existsSync(originalsDir)) {
    try { rmSync(originalsDir, { recursive: true, force: true }); } catch {}
  }
  delete process.env.OPENMEMORY_ORIGINALS_DIR;
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

  test("update re-weights an existing memory", () => {
    const s = Tools.memory(db, { operation: "store", content: "weighted" });
    expect(s.ok).toBe(true);
    if (!s.ok || s.payload.kind !== "memory_store") return;
    const id = s.payload.id;

    const up = Tools.memory(db, {
      operation: "update",
      id,
      importance: 0.95,
      category: "preference",
    });
    expect(up.ok).toBe(true);
    if (up.ok && up.payload.kind === "memory_update") {
      expect(up.payload.engram.importance).toBeCloseTo(0.95, 6);
      expect(up.payload.engram.category).toBe("preference");
      expect(up.payload.patched).toEqual(expect.arrayContaining(["importance", "category"]));
    }

    const got = Tools.memory(db, { operation: "get", id });
    expect(got.ok).toBe(true);
    if (got.ok && got.payload.kind === "memory_get") {
      expect(got.payload.engram.importance).toBeCloseTo(0.95, 6);
    }
  });

  test("update with no patch fields returns an error", () => {
    const s = Tools.memory(db, { operation: "store", content: "x" });
    if (!s.ok || s.payload.kind !== "memory_store") return;
    const r = Tools.memory(db, { operation: "update", id: s.payload.id });
    expect(r.ok).toBe(false);
  });

  test("update for missing id returns not_found", () => {
    const r = Tools.memory(db, { operation: "update", id: 99999, importance: 0.1 });
    expect(r.ok).toBe(false);
  });

  test("update content requires embedding", () => {
    const s = Tools.memory(db, { operation: "store", content: "to be rewritten" });
    if (!s.ok || s.payload.kind !== "memory_store") return;
    const r = Tools.memory(db, {
      operation: "update",
      id: s.payload.id,
      content: "rewritten text",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const reason = (r.error as { reason?: string }).reason ?? "";
      expect(reason).toContain("embedding");
    }
  });

  test("update content with embedding succeeds and patches content", () => {
    const s = Tools.memory(db, { operation: "store", content: "before" });
    if (!s.ok || s.payload.kind !== "memory_store") return;
    const vec = new Array(8).fill(0);
    vec[1] = 1;
    const r = Tools.memory(db, {
      operation: "update",
      id: s.payload.id,
      content: "after",
      embedding: vec,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "memory_update") {
      expect(r.payload.engram.content).toBe("after");
      expect(r.payload.patched).toEqual(expect.arrayContaining(["content", "embedding"]));
    }
  });

  test("update rejects non-finite embedding values", () => {
    const s = Tools.memory(db, { operation: "store", content: "x" });
    if (!s.ok || s.payload.kind !== "memory_store") return;
    const r = Tools.memory(db, {
      operation: "update",
      id: s.payload.id,
      embedding: [Number.NaN],
    });
    expect(r.ok).toBe(false);
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

  test("file mode copies source into originals/<id>/", async () => {
    const srcPath = join(tmpdir(), `openmemory_src_${Date.now()}.md`);
    await Bun.write(srcPath, "source body for originals");
    const r = await Tools.ingest(db, {
      operation: "file",
      path: srcPath,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === "ingest") {
      const root = Originals.originalsRoot(db);
      const destDir = Originals.originalsDirFor(root, r.payload.id);
      const copied = join(destDir, basename(srcPath));
      const file = Bun.file(copied);
      expect(await file.exists()).toBe(true);
      expect(await file.text()).toBe("source body for originals");
      // Cleanup.
      try { unlinkSync(srcPath); } catch {}
      try { rmSync(destDir, { recursive: true, force: true }); } catch {}
    }
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