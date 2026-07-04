import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as Originals from "../src/originals.ts";
import * as Memory from "../src/memory.ts";

let dbPath: string;
let db: ReturnType<typeof Memory.openDb>;
let scratch: string;

beforeEach(async () => {
  dbPath = join(tmpdir(), `openmemory_orig_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  db = Memory.openDb(dbPath);
  await Memory.runMigrations(db);
  scratch = join(tmpdir(), `openmemory_orig_src_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  try { rmSync(Originals.originalsRoot(db), { recursive: true, force: true }); } catch {}
});

describe("originalsRoot", () => {
  test("sits next to the database file", () => {
    const root = Originals.originalsRoot(db);
    const expected = join(dbPath, "..", "originals");
    expect(root).toBe(expected);
  });

  test("honours OPENMEMORY_ORIGINALS_DIR override", () => {
    const override = join(tmpdir(), `override-${Date.now()}`);
    process.env.OPENMEMORY_ORIGINALS_DIR = override;
    try {
      expect(Originals.originalsRoot(db)).toBe(override);
    } finally {
      delete process.env.OPENMEMORY_ORIGINALS_DIR;
    }
  });
});

describe("copySourceToOriginals", () => {
  test("copies a single file into <root>/<id>/<filename>", async () => {
    const src = join(scratch, "note.md");
    writeFileSync(src, "hello world");

    const root = Originals.originalsRoot(db);
    await Originals.ensureOriginalsRoot(root);
    const r = await Originals.copySourceToOriginals(root, 42, src);

    expect(r.kind).toBe("file");
    expect(r.bytes).toBe(Buffer.byteLength("hello world"));
    expect(r.files).toEqual(["42/note.md"]);

    const copied = join(root, "42", "note.md");
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("hello world");
  });

  test("mirrors a folder recursively under <root>/<id>/<foldername>", async () => {
    const folder = join(scratch, "project");
    mkdirSync(join(folder, "nested"), { recursive: true });
    writeFileSync(join(folder, "a.md"), "A");
    writeFileSync(join(folder, "b.json"), '{"k":1}');
    writeFileSync(join(folder, "nested", "c.txt"), "C");

    const root = Originals.originalsRoot(db);
    await Originals.ensureOriginalsRoot(root);
    const r = await Originals.copySourceToOriginals(root, 7, folder);

    expect(r.kind).toBe("folder");
    expect(r.bytes).toBe(
      Buffer.byteLength("A") + Buffer.byteLength('{"k":1}') + Buffer.byteLength("C"),
    );
    // All files end up under <root>/7/project/...
    expect(new Set(r.files)).toEqual(
      new Set([
        "7/project/a.md",
        "7/project/b.json",
        "7/project/nested/c.txt",
      ]),
    );

    const copiedFolder = join(root, "7", "project");
    expect(existsSync(join(copiedFolder, "nested", "c.txt"))).toBe(true);
    expect(readFileSync(join(copiedFolder, "a.md"), "utf8")).toBe("A");
  });

  test("refuses to overwrite an existing <id>/ directory", async () => {
    const src = join(scratch, "first.md");
    writeFileSync(src, "first");
    const root = Originals.originalsRoot(db);
    await Originals.ensureOriginalsRoot(root);
    await Originals.copySourceToOriginals(root, 99, src);

    const src2 = join(scratch, "second.md");
    writeFileSync(src2, "second");
    await expect(Originals.copySourceToOriginals(root, 99, src2)).rejects.toThrow(
      /already exists/,
    );
  });

  test("rejects non-file/non-folder sources", async () => {
    // A symlink to nowhere is neither a file nor a directory.
    const broken = join(scratch, "broken-link");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(join(scratch, "nope"), broken);
    } catch {
      // If symlinks aren't supported on this platform, skip the test.
      return;
    }
    const root = Originals.originalsRoot(db);
    await expect(Originals.copySourceToOriginals(root, 1, broken)).rejects.toThrow();
  });
});

describe("readSourceAsText", () => {
  test("returns the file body for single-file sources", async () => {
    const src = join(scratch, "plain.md");
    writeFileSync(src, "just text");
    expect(await Originals.readSourceAsText(src)).toBe("just text");
  });

  test("concatenates folder contents with per-file headers", async () => {
    const folder = join(scratch, "pack");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "one.md"), "first body");
    writeFileSync(join(folder, "two.md"), "second body");

    const out = await Originals.readSourceAsText(folder);
    expect(out).toContain("===== one.md =====");
    expect(out).toContain("first body");
    expect(out).toContain("===== two.md =====");
    expect(out).toContain("second body");
  });
});

describe("migrateLegacyOriginals", () => {
  test("moves legacy originals/<name> files into <root>/<id>/<filename>", async () => {
    const root = Originals.originalsRoot(db);
    mkdirSync(root, { recursive: true });
    const legacyFile = join(root, "8-25-summer-holiday.md");
    writeFileSync(legacyFile, "legacy body");

    // Seed the legacy column directly (mimics an old database).
    db.exec("ALTER TABLE engrams ADD COLUMN location TEXT");
    db.prepare(
      "INSERT INTO engrams (content, location) VALUES (?, ?)",
    ).run("legacy content", `originals/${basename(legacyFile)}`);

    const summary = await Originals.migrateLegacyOriginals(db);
    expect(summary.moved).toBe(1);

    const movedTo = join(root, "1", "8-25-summer-holiday.md");
    expect(existsSync(movedTo)).toBe(true);
    expect(existsSync(legacyFile)).toBe(false);
    expect(readFileSync(movedTo, "utf8")).toBe("legacy body");
  });

  test("reports missing sources without throwing", async () => {
    db.exec("ALTER TABLE engrams ADD COLUMN location TEXT");
    db.prepare(
      "INSERT INTO engrams (content, location) VALUES (?, ?)",
    ).run("orphan", "originals/does-not-exist.md");

    const summary = await Originals.migrateLegacyOriginals(db);
    expect(summary.missing).toBe(1);
    expect(summary.moved).toBe(0);
  });
});