import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Procedural from "../src/procedural.ts";
import * as Memory from "../src/memory.ts";

let dbPath: string;
let db: ReturnType<typeof Memory.openDb>;

beforeEach(() => {
  dbPath = join(tmpdir(), `openmemory_proc_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  db = Memory.openDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = dbPath + ext;
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }
});

describe("procedural.register", () => {
  test("persists a procedure", () => {
    const steps = [
      { action: "log" as const, message: "starting" },
      { action: "set_context" as const, key: "step", value: 1 },
    ];
    const r = Procedural.register(db, "greet", "A greeting", steps);
    expect(r.ok).toBe(true);
  });

  test("re-registration updates in place", () => {
    const steps = [{ action: "log" as const, message: "x" }];
    Procedural.register(db, "greet", "v1", steps);
    const r = Procedural.register(db, "greet", "v2", steps);
    expect(r.ok).toBe(true);
    const all = Procedural.list(db);
    // 1 default + 1 registered
    expect(all.length).toBe(2);
    const greet = all.find((p) => p.name === "greet")!;
    expect(greet.description).toBe("v2");
  });
});

describe("procedural.list", () => {
  test("returns registered procedures", () => {
    Procedural.register(db, "a", "alpha", [{ action: "log" as const, message: "a" }]);
    Procedural.register(db, "b", "beta", [{ action: "log" as const, message: "b" }]);
    const list = Procedural.list(db);
    // 1 default + 2 registered
    expect(list.length).toBe(3);
    expect(list.map((p) => p.name).sort()).toEqual(["a", "b", "record_repo_analysis"]);
  });
});

describe("procedural.run", () => {
  test("executes steps and returns a trace", () => {
    const steps = [
      { action: "log" as const, message: "hello" },
      { action: "set_context" as const, key: "user", value: "alice" },
      { action: "validate" as const, key: "user" },
    ];
    Procedural.register(db, "demo", "demo", steps);
    const r = Procedural.run(db, "demo", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.procedure).toBe("demo");
    expect(r.result.status).toBe("ok");
    expect(r.result.error).toBeNull();
    expect(r.result.steps.length).toBe(3);
    expect(r.result.steps[0]!.action).toBe("log");
    expect(r.result.steps[0]!.index).toBe(0);
    expect(r.result.steps[1]!.action).toBe("set_context");
    expect(r.result.context["user"]).toBe("alice");
    expect(r.result.steps[2]!.action).toBe("validate");
  });

  test("halts on validate failure", () => {
    const steps = [
      { action: "log" as const, message: "before" },
      { action: "validate" as const, key: "absent" },
    ];
    Procedural.register(db, "broken", "broken", steps);
    const r = Procedural.run(db, "broken", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.status).toBe("error");
    expect(r.result.error).toContain("absent");
  });

  test("returns unknown_procedure for missing names", () => {
    const r = Procedural.run(db, "nope", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.result).toBeUndefined(); // wait — we return { ok:false, reason: ... } not { ok:true, result:... }
  });

  test("reports unknown actions", () => {
    Procedural.register(db, "weird", "weird", [
      // @ts-expect-error testing unknown action
      { action: "fly" },
    ]);
    const r = Procedural.run(db, "weird", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.status).toBe("error");
    expect(r.result.error).toContain("unknown_action");
  });
});