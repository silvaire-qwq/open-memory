/**
 * MCP server over stdio — JSON-RPC 2.0.
 *
 * Implements the minimum surface needed by any MCP client:
 *
 *   - `initialize`             handshake
 *   - `notifications/initialized`  ack (no-op)
 *   - `tools/list`             advertises tools + their JSON schema
 *   - `tools/call`             invokes a tool
 *   - `ping`                   health probe
 *
 * Logging is silenced during the loop so wire-protocol bytes on stdout
 * are never interleaved with diagnostics.
 */

import type { Database } from "bun:sqlite";

import * as Tools from "./tools.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "openmemory", version: "1.0.0" };

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: "memory",
    description:
      "Persistent memory store (semantic search + temporal chains).\n\n" +
      "USE THIS PROACTIVELY. Whenever the conversation depends on prior knowledge " +
      "about the user — their name, preferences, projects, history, or any earlier " +
      "stated facts — call the `search` (or `get`) operation immediately to retrieve " +
      "the relevant engrams. Do not guess when memory could answer. Likewise, when the " +
      "user shares durable facts (name, role, preferences, decisions, ongoing tasks), " +
      "call `store` (or `ingest`) without waiting to be asked. Surface what you recall " +
      "naturally as part of the response.\n\n" +
      "REPO ANALYSIS: Whenever you finish analyzing a repository — its structure, " +
      "purpose, tech stack, key files, or any notable findings — you MUST store a " +
      "structured summary into memory immediately. Use operation `store` with " +
      "category=\"repo_analysis\", tags containing the repo name, and " +
      "project_id set to the repo identifier. This ensures past analyses are " +
      "retrievable on future interactions with the same or related repos.\n\n" +
      "Embedding policy: this server NEVER calls an embedding model on its own. If " +
      "the host (your caller) has a configured embedder, you MAY pass a precomputed " +
      "vector as `embedding` on `store` and `search` to use it instead of the " +
      "fallback lexical hash. Omit `embedding` and the server will hash-embed the " +
      "text locally (zero-cost, lexical-only).\n\n" +
      "Long-text handling: hash embeddings weight n-grams by corpus IDF via a " +
      "local BM25-style table, so common terms stop dragging unrelated documents " +
      "together. After bulk deletes/restores, run `reindex` to refresh the IDF " +
      "table and re-embed every engram.\n\n" +
      "Enrichment: when you store user-authored content (a document, post, or " +
      "conversation) you may also pass `original` (the verbatim original text) " +
      "and `location` (a file path, URL, or other identifier of where the original " +
      "lives) so the caller can retrieve full context later. Large artifacts " +
      "(projects, huge files) should omit `original` and only set `location`. " +
      "Operations: store, search, list, get, " +
      "delete, stats, chain, supersede, decayed, reindex.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "store",
            "search",
            "list",
            "get",
            "delete",
            "stats",
            "chain",
            "supersede",
            "decayed",
            "reindex",
          ],
        },
        content: { type: "string" },
        original: { type: "string" },
        location: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
        category: { type: "string" },
        importance: { type: "number" },
        query: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
        id: { type: "integer" },
        old_id: { type: "integer" },
        new_id: { type: "integer" },
        type: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        min_similarity: { type: "number" },
        project_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        include_archived: { type: "boolean" },
        threshold: { type: "number" },
      },
    },
  },
  {
    name: "ingest",
    description:
      "Ingest raw text or a server-readable file into memory.\n\n" +
      "USE THIS PROACTIVELY. When the user provides a document, transcript, long " +
      "note, or any sizeable block of text worth remembering, ingest it without asking. " +
      "File size policy: under 10MB → copy original to the server's `originals/` " +
      "folder automatically and set `location`. 10MB or more → ask the user for " +
      "three-way confirmation (copy / link-only / skip) before proceeding. The " +
      "`original` field is for small inline text from conversation; for file inputs " +
      "use `path` and let the server handle the copy.\n\n" +
      "After analyzing a repository, use this tool to store the full analysis " +
      "report (README summary, tech stack, architecture notes) into memory. " +
      "Set operation=\"file\" with the path to your analysis output, or " +
      "operation=\"text\" with the report inline. Operations: text, file.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["text", "file"] },
        content: { type: "string" },
        path: { type: "string" },
        original: { type: "string" },
        location: { type: "string" },
        category: { type: "string" },
        importance: { type: "number" },
        project_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: "procedures",
    description:
      "Inspect or run deterministic procedures. Procedures are named step " +
      "lists registered in the database.\n\n" +
      "USE THIS PROACTIVELY. When a multi-step workflow matches a registered " +
      "procedure, call `run` directly to execute it. The default procedure " +
      "`record_repo_analysis` should be run after every repository analysis " +
      "to confirm the analysis was recorded. Operations: list, run.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["list", "run"] },
        name: { type: "string" },
        input: { type: "object" },
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function serve(db: Database): Promise<void> {
  silenceLogging();
  await loop(db);
}

async function loop(db: Database): Promise<void> {
  const decoder = new TextDecoder();
  const stdin = Bun.stdin.stream();
  let buf = "";
  let pending: Promise<void> = Promise.resolve();

  const reader = stdin.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      // Last element may be a partial line; keep it for next read.
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcRequest;
          pending = pending.then(() => dispatch(db, msg));
        } catch (err) {
          sendError(null, PARSE_ERROR, `Parse error: ${(err as Error).message}`);
        }
      }
    }
  })().catch(() => {});

  // Hold the loop open until stdin closes.
  await new Promise<void>((resolve) => {
    stdin.pipeTo(new WritableStream({ write() {}, close() { resolve(); } })).catch(() => resolve());
  });

  await pending;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function write(payload: unknown): void {
  const json = JSON.stringify(payload) + "\n";
  // Synchronous write — required by MCP's stdio contract.
  // In compiled Bun binaries `process.stdout.write` is sometimes buffered;
  // writing directly to fd 1 (or via Bun's writer with .flush()) avoids
  // that. We use Bun's stdout writer which flushes per write.
  const writer = (Bun.stdout as unknown as { writer: { write: (s: string) => void } }).writer;
  if (writer && typeof writer.write === "function") {
    writer.write(json);
  } else {
    process.stdout.write(json);
  }
}

function sendResponse(id: JsonRpcId | null, result: unknown) {
  write({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId | null, code: number, message: string) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function silenceLogging() {
  // MCP uses stdout as the wire. Anything else written there corrupts the
  // protocol. We swallow logs to stderr.
  console.log = (..._args: unknown[]) => {};
  console.info = (..._args: unknown[]) => {};
  console.warn = (..._args: unknown[]) => {};
  console.error = (..._args: unknown[]) => {};
  console.debug = (..._args: unknown[]) => {};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

async function dispatch(db: Database, msg: JsonRpcRequest): Promise<void> {
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
      return;

    case "notifications/initialized":
      // No-op.
      return;

    case "tools/list":
      sendResponse(id, { tools: TOOL_DEFS });
      return;

    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await runTool(db, name, args);
      sendResponse(id, result);
      return;
    }

    case "ping":
      sendResponse(id, {});
      return;

    default:
      sendError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      return;
  }
}

async function runTool(db: Database, name: string, args: Record<string, unknown>) {
  let outcome;
  switch (name) {
    case "memory":
      outcome = Tools.memory(db, args);
      break;
    case "ingest":
      outcome = await Tools.ingest(db, args);
      break;
    case "procedures":
      outcome = Tools.procedures(db, args);
      break;
    default:
      return {
        content: [
          { type: "text", text: `Error: unknown tool ${name}` },
        ],
        isError: true,
      };
  }

  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: `Error: ${JSON.stringify(outcome.error)}` }],
      isError: true,
    };
  }

  return {
    content: [
      { type: "text", text: JSON.stringify(outcome.payload, null, 2) },
    ],
    isError: false,
  };
}