/**
 * CLI entry point.
 *
 * Usage:
 *   openmemory                 start MCP stdio loop
 *   openmemory --version
 *   openmemory --help
 *
 * Env:
 *   OPENMEMORY_DB_PATH         SQLite file (default: $XDG_DATA_HOME/openmemory/openmemory.db)
 */

import * as path from "node:path";
import * as os from "node:os";
import { mkdirSync } from "node:fs";

import { serve } from "./server.js";
import { openDb } from "./memory.js";

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
  serve(db).catch((err) => {
    process.stderr.write(`openmemory crashed: ${(err as Error).message}\n`);
    process.exit(1);
  });
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
  openmemory              start MCP stdio loop
  openmemory --version
  openmemory --help

ENVIRONMENT
  OPENMEMORY_DB_PATH      SQLite database file
  OPENMEMORY_DIM          embedding dimension (16..4096, default 256)

MCP TOOLS
  memory       store, search, list, get, delete, stats, chain, supersede, decayed
  ingest       text, file
  procedures   list, run
`;
}

main();