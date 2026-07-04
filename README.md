# OpenMemory

Minimal MCP server for persistent AI memory. Backed by SQLite + feature-hash embeddings. Zero external services or API keys required.

## How it works

OpenMemory is a [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that runs over stdio. It provides three tools:

- **`memory`** — store, search, list, get, delete, stats, chain, supersede, decayed, reindex
- **`ingest`** — ingest raw text or a file/folder into memory
- **`procedures`** — list and run deterministic multi-step procedures

Embeddings are computed in-process using FNV-1a feature hashing over character + word n-grams (1–3). Same input always produces the same vector.

## Source files

Every memory's source lives at **`originals/<id>/`** — a per-id folder sibling to the database file. Single files and full folder trees are both supported. The ingest tool copies whatever you give it into that folder automatically; there is no `location` field to set and no size prompt to navigate.

- `ingest file /path/to/notes.md` → `originals/<id>/notes.md`
- `ingest file /path/to/folder` → `originals/<id>/folder/<recursive contents>`

Re-ingest a source by superseding the old memory and storing a new one — the new memory gets its own `<id>/` folder, leaving the old one untouched for provenance.

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
| `OPENMEMORY_ORIGINALS_DIR` | sibling of the database file | Override for the `originals/` root |

## Tools reference

### `memory`

| Operation | Description |
|---|---|
| `store` | Persist a memory (content, category, importance, tags, metadata) |
| `search` | Semantic search by query text |
| `list` | Paginated list of recent memories |
| `get` | Fetch a single memory by id |
| `delete` | Soft-archive a memory |
| `update` | Edit an existing memory by id (importance, category, project_id, tags, metadata, content+embedding) |
| `stats` | Corpus statistics |
| `chain` | Temporal chain (supersession history) |
| `supersede` | Link old_id → new_id with a supersession type |
| `decayed` | Find memories below an importance threshold |
| `reindex` | Rebuild IDF table and re-embed every engram |

### `ingest`

| Operation | Description |
|---|---|
| `text` | Store inline text as a memory |
| `file` | Copy a file or folder into `originals/<id>/` and store its content as a memory |

### `procedures`

| Operation | Description |
|---|---|
| `list` | List registered procedures |
| `run` | Run a named procedure with input context |

## License

MIT