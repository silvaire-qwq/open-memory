/**
 * Owns the `originals/` directory and the rule that every memory's source
 * lives at `originals/<id>/`.
 *
 * Layout invariant:
 *
 *   <root>/<id>/file1.md
 *   <root>/<id>/file2.json
 *   <root>/<id>/nested/...
 *
 * `<root>` is the `originals/` directory next to the SQLite database. Each
 * engram owns a single subdirectory keyed by its SQLite id. The contents
 * mirror whatever the caller passed to `ingest file`: a single source file
 * becomes one file inside `<id>/`, a source folder becomes a recursive copy
 * of the whole tree.
 *
 * The canonical location of a memory's source is therefore always derivable
 * from its id — callers never pass a `location` field, and the database
 * does not store one.
 */

import { Database } from "bun:sqlite";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export type SourceKind = "file" | "folder";

export type CopyResult = {
  /** Absolute path to the canonical source directory (`<root>/<id>`). */
  root: string;
  /** Absolute path to the source root — same as `root` for now. */
  location: string;
  /** Whether the source was a single file or a folder. */
  kind: SourceKind;
  /** Every regular file copied, as paths relative to `root`. */
  files: string[];
  /** Total bytes copied across all files. */
  bytes: number;
};

// ---------------------------------------------------------------------------
// Root directory
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical `originals/` directory for a given database handle.
 *
 * The directory sits next to the database file so a backup of the data
 * directory carries both the SQLite file and its source artefacts together.
 * For in-memory databases (`:memory:`, used by tests) we fall back to a
 * tmpdir-based scratch path.
 *
 * Honours `OPENMEMORY_ORIGINALS_DIR` if set, otherwise derives from the
 * database filename.
 */
export function originalsRoot(db: Database): string {
  const override = process.env.OPENMEMORY_ORIGINALS_DIR;
  if (override && override.trim() !== "") return resolve(override);

  const dbPath = db.filename ?? "";
  if (!dbPath || dbPath === ":memory:") {
    return join(tmpdir(), "openmemory-originals");
  }
  return join(dirname(dbPath), "originals");
}

/** Create the originals root directory if it doesn't exist yet. */
export async function ensureOriginalsRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

/** Absolute path to a single engram's source directory. */
export function originalsDirFor(root: string, id: number): string {
  return join(root, String(id));
}

/**
 * Stat a candidate source path and normalise errors so callers can map
 * ENOENT into a clean "file not found" without inspecting errno.
 */
export async function statSource(path: string): Promise<{ isFile: () => boolean; isDirectory: () => boolean; size: number }> {
  return (await stat(resolve(path))) as unknown as {
    isFile: () => boolean;
    isDirectory: () => boolean;
    size: number;
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Copy `sourcePath` (a file or folder) into `<root>/<id>/`.
 *
 *   - File source → `<root>/<id>/<basename(sourcePath)>`.
 *   - Folder source → `<root>/<id>/<basename(sourcePath)>/...`,
 *     preserving the directory tree.
 *
 * Refuses to copy if the source is not a regular file or directory, or if
 * the destination already contains data for this id (idempotency guard —
 * callers should not be re-copying).
 */
export async function copySourceToOriginals(
  root: string,
  id: number,
  sourcePath: string,
): Promise<CopyResult> {
  const abs = resolve(sourcePath);
  const info = await stat(abs);
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`not a regular file or directory: ${abs}`);
  }

  const destDir = originalsDirFor(root, id);
  if (existsSync(destDir)) {
    // Don't silently overwrite an existing source tree. The caller can
    // delete the engram and re-ingest if a refresh is genuinely wanted.
    throw new Error(`originals directory already exists: ${destDir}`);
  }
  await mkdir(destDir, { recursive: true });

  let files: string[] = [];
  let bytes = 0;

  if (info.isFile()) {
    const destFile = join(destDir, basename(abs));
    await copyFile(abs, destFile);
    files.push(relativeInside(root, destFile));
    bytes += info.size;
  } else {
    // Mirror the folder name inside the per-id directory so two folders
    // ingested into the same id (which we forbid above) can't ever
    // collide, and so the source's top-level layout is preserved.
    const destSubdir = join(destDir, basename(abs));
    await mkdir(destSubdir, { recursive: true });
    const sub = await copyDir(abs, destSubdir, root);
    files = sub.files;
    bytes = sub.bytes;
  }

  return {
    root,
    location: destDir,
    kind: info.isDirectory() ? "folder" : "file",
    files,
    bytes,
  };
}

async function copyDir(
  src: string,
  dest: string,
  root: string,
): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = [];
  let bytes = 0;
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyDir(srcPath, destPath, root);
      files.push(...sub.files);
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
      const st = await stat(srcPath);
      files.push(relativeInside(root, destPath));
      bytes += st.size;
    }
    // Symlinks and specials are skipped intentionally — they have no
    // portable representation on Windows and we never want them in a
    // memory source tree anyway.
  }
  return { files, bytes };
}

function relativeInside(root: string, abs: string): string {
  // Both arguments are absolute, so a simple prefix strip is enough.
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

// ---------------------------------------------------------------------------
// Content capture (for the memory body itself)
// ---------------------------------------------------------------------------

/**
 * Best-effort text extraction for the memory content field.
 *
 * For single-file sources this is just the file's text. For folder sources
 * we concatenate every regular file with a header so the embedded content
 * stays searchable; binary-looking files (null bytes in the first 8 KiB)
 * are listed by relative path but skipped from the body.
 *
 * Always reads through `Bun.file()` so a 100MB+ folder doesn't allocate
 * eagerly — we copy first, then stream the content separately.
 */
export async function readSourceAsText(sourcePath: string): Promise<string> {
  const abs = resolve(sourcePath);
  const info = await stat(abs);
  if (info.isFile()) return Bun.file(abs).text();

  const lines: string[] = [];
  await collectText(abs, abs, lines);
  return lines.join("\n");
}

async function collectText(
  base: string,
  dir: string,
  out: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    const rel = p.slice(base.length + 1);
    if (entry.isDirectory()) {
      await collectText(base, p, out);
    } else if (entry.isFile()) {
      if (await looksBinary(p)) {
        out.push(`\n[skip binary: ${rel}]\n`);
        continue;
      }
      const text = await Bun.file(p).text();
      out.push(`\n===== ${rel} =====\n${text}`);
    }
  }
}

async function looksBinary(path: string): Promise<boolean> {
  const file = Bun.file(path);
  const slice = file.slice(0, 8192);
  const buf = await slice.arrayBuffer();
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) {
    if (view[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Migration helpers (used by memory.openDb on first open after upgrade)
// ---------------------------------------------------------------------------

/**
 * Move any pre-existing `originals/<name>` files (legacy flat layout) into
 * the per-id folder scheme. Returns the list of ids that were migrated.
 *
 * The legacy schema stored a `location TEXT` column on each engram with
 * values like `originals/8-25-summer-holiday.md`. After the migration that
 * column is dropped, so the only durable record of where each memory's
 * source lives is the new `<root>/<id>/<filename>` tree.
 */
export async function migrateLegacyOriginals(
  db: Database,
): Promise<{ moved: number; missing: number }> {
  // Fresh databases (and databases that have already been migrated) won't
  // have a `location` column at all. Probe the schema first so we don't
  // prepare a statement that names a missing column.
  const cols = db
    .prepare("PRAGMA table_info(engrams)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "location")) {
    return { moved: 0, missing: 0 };
  }

  const root = originalsRoot(db);
  const rows = db
    .prepare(
      "SELECT id, location FROM engrams WHERE location IS NOT NULL AND location <> ''",
    )
    .all() as Array<{ id: number; location: string }>;

  let moved = 0;
  let missing = 0;
  for (const { id, location } of rows) {
    const oldPath = resolveLegacyPath(db, location);
    if (!oldPath) continue;
    if (!existsSync(oldPath)) {
      missing++;
      continue;
    }
    const destDir = originalsDirFor(root, id);
    if (existsSync(destDir)) continue; // already migrated
    await mkdir(destDir, { recursive: true });
    const destFile = join(destDir, basename(oldPath));
    try {
      await rename(oldPath, destFile);
      moved++;
    } catch {
      // rename across devices can fail; fall back to copy + unlink.
      await copyFile(oldPath, destFile);
      try {
        await rm(oldPath, { force: true });
      } catch {}
      moved++;
    }
  }
  return { moved, missing };
}

function resolveLegacyPath(db: Database, location: string): string | null {
  if (!location) return null;
  // The legacy values were repo-relative paths like "originals/foo.md".
  // We only know how to interpret those if the db file is on disk; for
  // in-memory databases there is no "old" path to look at.
  const dbPath = db.filename ?? "";
  if (!dbPath || dbPath === ":memory:") return null;
  const base = dirname(dbPath);
  const abs = resolve(base, location);
  // Defence-in-depth: refuse to touch anything outside the originals dir.
  const originalsAbs = resolve(base, "originals");
  if (!abs.startsWith(originalsAbs + sep) && abs !== originalsAbs) {
    return null;
  }
  return abs;
}