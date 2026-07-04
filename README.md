# OpenMemory

Minimal MCP server for persistent AI memory. Backed by SQLite + feature-hash embeddings. Zero external services or API keys required.

## How it works

OpenMemory is a [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that runs over stdio. It provides three tools:

- **`memory`** — store, search, list, get, delete, stats, chain, supersede, decayed, reindex
- **`ingest`** — ingest raw text or a file into memory
- **`procedures`** — list and run deterministic multi-step procedures

Embeddings are computed in-process using FNV-1a feature hashing over character + word n-grams (1–3). Same input always produces the same vector.

## Requirements

- [Bun](https://bun.sh) >= 1.3.0

## Quick start

```bash
bun install
bun start
```

## MCP client configuration

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "bun",
      "args": ["run", "/path/to/openmemory/src/index.ts"],
      "env": {
        "OPENMEMORY_DB_PATH": "/path/to/data/openmemory.db"
      }
    }
  }
}
```

Or use the compiled binary:

```bash
bun run build
./bin/openmemory
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENMEMORY_DB_PATH` | `$XDG_DATA_HOME/openmemory/openmemory.db` | SQLite database file path |
| `OPENMEMORY_DIM` | `256` | Embedding dimension (16–4096) |

## Tools reference

### `memory`

| Operation | Description |
|---|---|
| `store` | Persist a memory (content, category, importance, tags, metadata) |
| `search` | Semantic search by query text |
| `list` | Paginated list of recent memories |
| `get` | Fetch a single memory by id |
| `delete` | Soft-archive a memory |
| `stats` | Corpus statistics |
| `chain` | Temporal chain (supersession history) |
| `supersede` | Link old_id → new_id with a supersession type |
| `decayed` | Find memories below an importance threshold |
| `reindex` | Rebuild IDF table and re-embed every engram |

### `ingest`

| Operation | Description |
|---|---|
| `text` | Store inline text as a memory |
| `file` | Read a file from disk and store its content as a memory |

### `procedures`

| Operation | Description |
|---|---|
| `list` | List registered procedures |
| `run` | Run a named procedure with input context |

## License

MIT
