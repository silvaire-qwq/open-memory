/**
 * Deterministic, JSON-serialisable procedure runner.
 *
 * A procedure is a named list of steps. Each step is a record with an
 * `action` field. The runner walks the list top-to-bottom and returns a
 * structured trace.
 *
 * Built-in actions:
 *   - "log"          records a message in the trace
 *   - "set_context"  sets a value on the run-scoped context map
 *   - "validate"     asserts a key exists in context
 *   - "delay"        pauses for `ms` milliseconds
 */

import { Database } from "bun:sqlite";
import type { ProcedureRunResult, ProcedureStep } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Registers (or updates) a procedure in the database. */
export function register(
  db: Database,
  name: string,
  description: string,
  steps: ProcedureStep[],
): { ok: true; id: number } | { ok: false; reason: string } {
  try {
    const stmt = db.prepare(`
      INSERT INTO procedures (name, description, steps)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        steps = excluded.steps,
        updated_at = datetime('now')
    `);
    const info = stmt.run(name, description, JSON.stringify(steps));
    return { ok: true, id: Number(info.lastInsertRowid) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Seed default procedures into a fresh database. */
export function seedDefaults(db: Database): void {
  register(db, "record_repo_analysis", "Store a structured summary of a completed repository analysis into memory. Call this after you finish analyzing any repo.", [
    { action: "log", message: "Preparing repo analysis record..." },
    { action: "set_context", key: "analysis_recorded", value: true },
  ]);
}

/** Lists all procedures. */
export function list(db: Database) {
  const rows = db
    .prepare("SELECT id, name, description, steps FROM procedures ORDER BY name ASC")
    .all() as Array<{ id: number; name: string; description: string; steps: string }>;
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    step_count: (JSON.parse(r.steps) as unknown[]).length,
  }));
}

/** Runs a named procedure. */
export function run(
  db: Database,
  name: string,
  input: Record<string, unknown> = {},
):
  | { ok: true; result: ProcedureRunResult }
  | { ok: false; reason: { kind: "unknown_procedure"; name: string } } {
  const row = db
    .prepare("SELECT steps FROM procedures WHERE name = ?")
    .get(name) as { steps: string } | null;
  if (!row) return { ok: false, reason: { kind: "unknown_procedure", name } };

  const steps = JSON.parse(row.steps) as ProcedureStep[];
  const started = Date.now();
  const ctx: Record<string, unknown> = { ...input, _procedure: name };
  const trace: ProcedureRunResult["steps"] = [];
  let errorReason: string | null = null;

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx]!;
    const out = runStep(step, ctx, idx);
    trace.push(out.entry);
    if (out.kind === "ok") {
      if (out.entry.action === "set_context" && out.entry.key && "value" in step) {
        ctx[String(out.entry.key)] = step.value;
      }
    } else {
      errorReason = out.reason;
      break;
    }
  }

  return {
    ok: true,
    result: {
      procedure: name,
      status: errorReason ? "error" : "ok",
      steps: trace,
      context: ctx,
      error: errorReason,
      duration_ms: Date.now() - started,
    },
  };
}

// ---------------------------------------------------------------------------
// Step interpreter
// ---------------------------------------------------------------------------

type StepOutput =
  | { kind: "ok"; entry: ProcedureRunResult["steps"][number] }
  | { kind: "err"; entry: ProcedureRunResult["steps"][number]; reason: string };

function runStep(step: ProcedureStep, _ctx: Record<string, unknown>, idx: number): StepOutput {
  const action = step.action;

  switch (action) {
    case "log": {
      return {
        kind: "ok",
        entry: { index: idx, action: "log", status: "ok", message: String(step.message ?? "") },
      };
    }

    case "set_context": {
      if (step.key === undefined) {
        return {
          kind: "err",
          reason: "missing_key_field",
          entry: { index: idx, action: "set_context", status: "error" },
        };
      }
      return {
        kind: "ok",
        entry: { index: idx, action: "set_context", status: "ok", key: step.key },
      };
    }

    case "validate": {
      if (step.key === undefined) {
        return {
          kind: "err",
          reason: "missing_key_field",
          entry: { index: idx, action: "validate", status: "error" },
        };
      }
      const keyStr = String(step.key);
      if (!(keyStr in _ctx)) {
        const msg = step.error ?? `missing key: ${keyStr}`;
        return {
          kind: "err",
          reason: msg,
          entry: { index: idx, action: "validate", status: "error", key: step.key },
        };
      }
      return {
        kind: "ok",
        entry: { index: idx, action: "validate", status: "ok", key: step.key },
      };
    }

    case "delay": {
      if (typeof step.ms !== "number") {
        return {
          kind: "err",
          reason: "missing_ms_field",
          entry: { index: idx, action: "delay", status: "error" },
        };
      }
      const wait = Math.max(0, step.ms);
      // Synchronous sleep using Atomics.wait — Bun-compatible.
      const sab = new SharedArrayBuffer(4);
      const i32 = new Int32Array(sab);
      Atomics.wait(i32, 0, 0, wait);
      return {
        kind: "ok",
        entry: { index: idx, action: "delay", status: "ok", ms: wait },
      };
    }

    default:
      return {
        kind: "err",
        reason: `unknown_action:${String(action)}`,
        entry: { index: idx, action: String(action), status: "error" },
      };
  }
}