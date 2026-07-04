import * as path from "node:path";
import * as os from "node:os";
import { mkdirSync } from "node:fs";

import { spawnSync } from "node:child_process";
import { serve } from "./server.js";
import { openDb } from "./memory.js";
import * as Tools from "./tools.js";
import type { Database } from "bun:sqlite";

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write("openmemory 1.0.0\n");
    process.exit(0);
  }

  const dbPath = resolveDbPath();
  ensureDir(dbPath);
  const db = openDb(dbPath);

  if (args[0] === "tui") {
    // Ink needs stdin.setRawMode — compiled binary can't do it.
    // Spawn bun to run the source file directly.
    const tryPath = (p: string) => {
      try { return Bun.file(p).size > 0; } catch { return false; }
    };
    const cwdSrc = path.resolve(process.cwd(), "src", "tui.ts");
    const binSrc = path.resolve(path.dirname(process.argv[1] || ""), "..", "src", "tui.ts");
    const tuiPath = tryPath(cwdSrc) ? cwdSrc : tryPath(binSrc) ? binSrc : "";
    if (!tuiPath) { process.stderr.write("Cannot find src/tui.ts — run from project directory\n"); process.exit(1); }
    const cp = spawnSync("bun", ["run", tuiPath], {
      stdio: "inherit",
      env: { ...process.env, OPENMEMORY_DB_PATH: dbPath },
      cwd: process.cwd(),
    });
    process.exit(cp.status ?? 0);
  }

  if (args.length > 0) {
    runCli(db, args).catch((err) => {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    });
  } else {
    serve(db).catch((err) => {
      process.stderr.write(`openmemory crashed: ${(err as Error).message}\n`);
      process.exit(1);
    });
  }
}

async function runCli(db: Database, args: string[]): Promise<void> {
  const tool = args[0];
  const op = args[1];

  if (!tool || !op) {
    process.stderr.write("Usage: openmemory <tool> <operation> [key=value ...]\n");
    process.exit(1);
  }

  const kvArgs: Record<string, unknown> = { operation: op };

  let positional = "";
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    if (eq > 0) {
      const k = a.slice(0, eq);
      const v = a.slice(eq + 1);
      kvArgs[k] = tryParseJson(v);
    } else {
      positional = a;
    }
  }

  switch (tool) {
    case "memory": {
      if (positional) {
        if (op === "search") kvArgs["query"] = positional;
        else if (op === "store") kvArgs["content"] = positional;
        else if (op === "get" || op === "delete" || op === "chain") kvArgs["id"] = Number(positional);
      }
      const result = Tools.memory(db, kvArgs);
      printResult(result);
      break;
    }
    case "ingest": {
      if (op === "file" && positional) kvArgs["path"] = positional;
      else if (op === "text" && positional) kvArgs["content"] = positional;
      const result = await Tools.ingest(db, kvArgs);
      printResult(result);
      break;
    }
    case "procedures": {
      if (positional) kvArgs["name"] = positional;
      const result = Tools.procedures(db, kvArgs);
      printResult(result);
      break;
    }
    default:
      process.stderr.write(`Unknown tool: ${tool}\n`);
      process.exit(1);
  }
}

function printResult(result: Tools.ToolResult): void {
  if (!result.ok) {
    process.stderr.write(`Error: ${JSON.stringify(result.error)}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result.payload, null, 2) + "\n");
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
}

function resolveDbPath(): string {
  const fromEnv = process.env.OPENMEMORY_DB_PATH || process.env.MIMO_DB_PATH;
  if (fromEnv) return fromEnv;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "openmemory", "openmemory.db");
}

function usage(): string {
  return `
openmemory — persistent memory MCP server

USAGE
  openmemory                          start MCP stdio loop
  openmemory tui                      interactive TUI (memory manager)
  openmemory <tool> <op> [args...]    CLI mode (run once and exit)
  openmemory --version
  openmemory --help

CLI EXAMPLES
  openmemory tui
  openmemory memory search "query text"
  openmemory memory store "content here" category=fact importance=0.8
  openmemory memory list limit=10
  openmemory memory get id=42
  openmemory memory delete id=42
  openmemory memory stats
  openmemory ingest file /path/to/file.txt category=note
  openmemory procedures list

ENVIRONMENT
  OPENMEMORY_DB_PATH      SQLite database file
  OPENMEMORY_DIM          embedding dimension (16..4096, default 256)
`;
}

main();
