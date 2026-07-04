import * as path from "node:path";
import * as os from "node:os";
import { mkdirSync } from "node:fs";

import { serve } from "./server.js";
import { openDb, runMigrations } from "./memory.js";
import * as Tools from "./tools.js";
import { startTui } from "./tui.js";
import type { Database } from "bun:sqlite";

async function main(): Promise<void> {
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
  await runMigrations(db);

  if (args[0] === "tui") {
    startTui(db);
    return;
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

  const positionals: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    if (eq > 0) {
      const k = a.slice(0, eq);
      const v = a.slice(eq + 1);
      kvArgs[k] = tryParseJson(v);
    } else {
      positionals.push(a);
    }
  }

  const positional = positionals[0] ?? "";

  switch (tool) {
    case "memory": {
      if (op === "update") {
        // update accepts up to two positionals: <id> [<importance>].
        // Other fields must be passed as key=value (importance=, category=, etc.)
        if (positionals[0] !== undefined) kvArgs["id"] = Number(positionals[0]);
        if (positionals[1] !== undefined) kvArgs["importance"] = Number(positionals[1]);
      } else if (positional) {
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
  openmemory memory update id=42 importance=0.9 category=fact
  openmemory memory update 42 0.9
  openmemory memory stats
  openmemory ingest file /path/to/file.txt category=note
  openmemory procedures list

ENVIRONMENT
  OPENMEMORY_DB_PATH          SQLite database file
  OPENMEMORY_DIM              embedding dimension (16..4096, default 256)
  OPENMEMORY_ORIGINALS_DIR    override the originals/ root (default: sibling of db)

SOURCES
  Every ingested file is copied into originals/<id>/ next to the database
  (single file or recursive folder mirror). Memory rows no longer carry a
  location field — the address is always originals/<id>/.
`;
}

main().catch((err) => {
  process.stderr.write(`openmemory crashed: ${(err as Error).message}\n`);
  process.exit(1);
});
