/**
 * Tool dispatch layer: maps MCP tool names to Memory / ProceduralStore calls.
 *
 * Each function returns either `{ ok: true, payload }` (rendered as JSON) or
 * `{ ok: false, error }` (rendered as an error message).
 */

import { Database } from "bun:sqlite";

import * as Memory from "./memory.js";
import * as Procedural from "./procedural.js";
import * as Embedder from "./embedder.js";

export type ToolPayload =
  | { kind: "memory_store"; stored: boolean; duplicate?: boolean; id: number }
  | { kind: "memory_search"; query: string; count: number; results: Memory.Engram[] }
  | { kind: "memory_list"; count: number; results: Memory.Engram[] }
  | { kind: "memory_get"; engram: Memory.Engram }
  | { kind: "memory_delete"; deleted: boolean; id: number }
  | { kind: "memory_stats"; stats: ReturnType<typeof Memory.stats> }
  | { kind: "memory_chain"; id: number; count: number; chain: Memory.Engram[] }
  | { kind: "memory_supersede"; old_id: number; new_id: number; type: string }
  | { kind: "memory_decayed"; threshold: number; count: number; results: Memory.Engram[] }
  | { kind: "memory_reindex"; updated: number }
  | { kind: "ingest"; ingested: boolean; duplicate?: boolean; id: number; mode: "text" | "file" }
  | { kind: "procedures_list"; procedures: ReturnType<typeof Procedural.list> }
  | { kind: "procedures_run"; result: Procedural.ProcedureRunResult };

export type ToolError =
  | { kind: "missing_field"; field: string }
  | { kind: "invalid_input"; reason: string }
  | { kind: "not_found"; id?: number; name?: string }
  | { kind: "already_superseded" }
  | { kind: "unknown_op"; op: string }
  | { kind: "unknown_tool"; tool: string }
  | { kind: "file_read_failed"; path: string; reason: string };

export type ToolResult =
  | { ok: true; payload: ToolPayload }
  | { ok: false; error: ToolError };

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

export function memory(db: Database, args: Record<string, unknown>): ToolResult {
  const op = stringField(args, "operation");

  switch (op) {
    case "store":
      return opStore(db, args);
    case "search":
      return opSearch(db, args);
    case "list":
      return opList(db, args);
    case "get":
      return opGet(db, args);
    case "delete":
      return opDelete(db, args);
    case "stats":
      return ok({ kind: "memory_stats", stats: Memory.stats(db) });
    case "chain":
      return opChain(db, args);
    case "supersede":
      return opSupersede(db, args);
    case "decayed":
      return opDecayed(db, args);
    case "reindex":
      return opReindex(db);
    default:
      return err({ kind: "unknown_op", op: String(op) });
  }
}

function opStore(db: Database, args: Record<string, unknown>): ToolResult {
  const content = stringField(args, "content");
  if (!content) return err({ kind: "missing_field", field: "content" });

  const opts: Memory.StoreOptions = {};
  const category = stringField(args, "category");
  if (category) opts.category = category;
  const importance = numberField(args, "importance");
  if (importance !== undefined) opts.importance = importance;
  const projectId = stringField(args, "project_id");
  if (projectId) opts.project_id = projectId;
  const tags = stringArrayField(args, "tags");
  if (tags) opts.tags = tags;
  const metadata = objectField(args, "metadata");
  if (metadata) opts.metadata = metadata;
  const embeddingField = numberArrayField(args, "embedding");
  if (embeddingField !== undefined) {
    const bad = embeddingField.find((x) => !Number.isFinite(x));
    if (bad !== undefined) return err({ kind: "invalid_input", reason: "embedding contains non-finite values" });
    opts.embedding = embeddingField;
  }

  const result = Memory.store(db, content, opts);
  if (!result.ok && result.reason === "empty") {
    return err({ kind: "invalid_input", reason: "content is empty" });
  }
  if (!result.ok && result.reason === "duplicate") {
    // Re-fetch the existing id.
    const existing = db
      .prepare("SELECT id FROM engrams WHERE content = ? LIMIT 1")
      .get(content) as { id: number } | null;
    if (!existing) return err({ kind: "invalid_input", reason: "duplicate but not found" });
    return ok({
      kind: "memory_store",
      stored: true,
      duplicate: true,
      id: existing.id,
    });
  }
  if (!result.ok) return err({ kind: "invalid_input", reason: result.reason });
  return ok({ kind: "memory_store", stored: true, id: result.id });
}

function opSearch(db: Database, args: Record<string, unknown>): ToolResult {
  const query = stringField(args, "query");
  if (!query) return err({ kind: "missing_field", field: "query" });

  const opts: Memory.SearchOptions = {};
  const limit = numberField(args, "limit");
  if (limit !== undefined) opts.limit = limit;
  const minSim = numberField(args, "min_similarity");
  if (minSim !== undefined) opts.min_similarity = minSim;
  const category = stringField(args, "category");
  if (category) opts.category = category;
  const projectId = stringField(args, "project_id");
  if (projectId) opts.project_id = projectId;
  const embeddingField = numberArrayField(args, "embedding");
  if (embeddingField !== undefined) {
    const bad = embeddingField.find((x) => !Number.isFinite(x));
    if (bad !== undefined) return err({ kind: "invalid_input", reason: "embedding contains non-finite values" });
    opts.embedding = embeddingField;
  }

  const results = Memory.search(db, query, opts);
  return ok({ kind: "memory_search", query, count: results.length, results });
}

function opList(db: Database, args: Record<string, unknown>): ToolResult {
  const opts: Memory.ListOptions = {};
  const limit = numberField(args, "limit");
  if (limit !== undefined) opts.limit = limit;
  const offset = numberField(args, "offset");
  if (offset !== undefined) opts.offset = offset;
  const category = stringField(args, "category");
  if (category) opts.category = category;
  const projectId = stringField(args, "project_id");
  if (projectId) opts.project_id = projectId;
  const includeArchived = booleanField(args, "include_archived");
  if (includeArchived !== undefined) opts.include_archived = includeArchived;

  const results = Memory.list(db, opts);
  return ok({ kind: "memory_list", count: results.length, results });
}

function opGet(db: Database, args: Record<string, unknown>): ToolResult {
  const id = numberField(args, "id");
  if (id === undefined) return err({ kind: "missing_field", field: "id" });

  const engram = Memory.get(db, id);
  if (!engram) return err({ kind: "not_found", id });
  return ok({ kind: "memory_get", engram });
}

function opDelete(db: Database, args: Record<string, unknown>): ToolResult {
  const id = numberField(args, "id");
  if (id === undefined) return err({ kind: "missing_field", field: "id" });

  const result = Memory.softDelete(db, id);
  if (!result.ok) return err({ kind: "not_found", id });
  return ok({ kind: "memory_delete", deleted: true, id });
}

function opChain(db: Database, args: Record<string, unknown>): ToolResult {
  const id = numberField(args, "id");
  if (id === undefined) return err({ kind: "missing_field", field: "id" });

  const c = Memory.chain(db, id);
  if (!c) return err({ kind: "not_found", id });
  return ok({ kind: "memory_chain", id, count: c.length, chain: c });
}

function opSupersede(db: Database, args: Record<string, unknown>): ToolResult {
  const oldId = numberField(args, "old_id");
  const newId = numberField(args, "new_id");
  if (oldId === undefined || newId === undefined) {
    return err({ kind: "missing_field", field: "old_id and new_id" });
  }
  const type = stringField(args, "type") ?? "update";

  const result = Memory.supersede(db, oldId, newId, type);
  if (!result.ok) {
    if (result.reason === "not_found") return err({ kind: "not_found" });
    if (result.reason === "already_superseded")
      return err({ kind: "already_superseded" });
    return err({ kind: "invalid_input", reason: result.reason });
  }
  return ok({ kind: "memory_supersede", old_id: oldId, new_id: newId, type });
}

function opDecayed(db: Database, args: Record<string, unknown>): ToolResult {
  const threshold = numberField(args, "threshold") ?? 0.1;
  const limit = numberField(args, "limit") ?? 50;
  const results = Memory.decayed(db, threshold, limit);
  return ok({
    kind: "memory_decayed",
    threshold,
    count: results.length,
    results,
  });
}

function opReindex(db: Database): ToolResult {
  const result = Memory.reindex(db);
  return ok({ kind: "memory_reindex", updated: result.updated });
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

export async function ingest(
  db: Database,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const op = stringField(args, "operation");

  if (op === "text") {
    const content = stringField(args, "content");
    if (!content) return err({ kind: "missing_field", field: "content" });
    const inner = memory(db, {
      ...args,
      operation: "store",
      content,
    });
    if (!inner.ok) return inner;
    if (inner.payload.kind === "memory_store") {
      return ok({
        kind: "ingest",
        ingested: true,
        id: inner.payload.id,
        duplicate: inner.payload.duplicate,
        mode: "text",
      });
    }
    return err({ kind: "invalid_input", reason: "store returned unexpected payload" });
  }

  if (op === "file") {
    const path = stringField(args, "path");
    if (!path) return err({ kind: "missing_field", field: "path" });
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return err({ kind: "file_read_failed", path, reason: "file not found" });
    }
    try {
      const content = await file.text();
      const inner = memory(db, {
        ...args,
        operation: "store",
        content,
        path: undefined,
      });
      if (!inner.ok) return inner;
      if (inner.payload.kind === "memory_store") {
        return ok({
          kind: "ingest",
          ingested: true,
          id: inner.payload.id,
          duplicate: inner.payload.duplicate,
          mode: "file",
        });
      }
      return err({ kind: "invalid_input", reason: "store returned unexpected payload" });
    } catch (err) {
      return err({
        kind: "file_read_failed",
        path,
        reason: (err as Error).message,
      });
    }
  }

  return err({ kind: "unknown_op", op: String(op) });
}

// ---------------------------------------------------------------------------
// procedures
// ---------------------------------------------------------------------------

export function procedures(db: Database, args: Record<string, unknown>): ToolResult {
  const op = stringField(args, "operation");

  if (op === "list") {
    return ok({ kind: "procedures_list", procedures: Procedural.list(db) });
  }

  if (op === "run") {
    const name = stringField(args, "name");
    if (!name) return err({ kind: "missing_field", field: "name" });
    const input = objectField(args, "input") ?? {};
    const result = Procedural.run(db, name, input);
    if (!result.ok) return err({ kind: "not_found", name });
    return ok({ kind: "procedures_run", result: result.result });
  }

  return err({ kind: "unknown_op", op: String(op) });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(payload: ToolPayload): ToolResult {
  return { ok: true, payload };
}

function err(error: ToolError): ToolResult {
  return { ok: false, error };
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberArrayField(
  args: Record<string, unknown>,
  key: string,
): number[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "number")) return undefined;
  return v as number[];
}

function numberField(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function booleanField(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function stringArrayField(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

function objectField(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}