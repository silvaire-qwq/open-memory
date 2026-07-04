# Install OpenMemory MCP Server

## Prerequisites

Install [Bun](https://bun.sh) >= 1.3.0:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Setup

```bash
git clone https://github.com/silvaire-qwq/open-memory.git
cd open-memory
bun install
```

## Start the server

```bash
bun start
```

Default database path: `$XDG_DATA_HOME/openmemory/openmemory.db`

## MCP client config

### Development (run source with Bun)

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "bun",
      "args": ["run", "/absolute/path/open-memory/src/index.ts"],
      "env": {
        "OPENMEMORY_DB_PATH": "/absolute/path/open-memory/openmemory.db"
      }
    }
  }
}
```

### Production (compiled binary)

```bash
cd open-memory
bun run build
```

Then:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "/absolute/path/open-memory/bin/openmemory",
      "args": [],
      "env": {
        "OPENMEMORY_DB_PATH": "/absolute/path/open-memory/openmemory.db"
      }
    }
  }
}
```

## Verify

After starting, call:

1. `memory` → `store` with content="Hello, I am an AI assistant"
2. `memory` → `search` with query="AI assistant"
3. `memory` → `stats`

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENMEMORY_DB_PATH` | `$XDG_DATA_HOME/openmemory/openmemory.db` | SQLite database file |
| `OPENMEMORY_DIM` | `256` | Embedding dimension (16–4096) |

## Tools

### memory
- `store` — store a memory (supports content, category, importance, tags, metadata)
- `search` — semantic search
- `list` — paginated recent memories
- `get` — fetch by id
- `delete` — soft-delete
- `stats` — corpus stats
- `chain` — view version chain (supersession history)
- `supersede` — link old_id → new_id
- `decayed` — find low-importance memories
- `reindex` — rebuild IDF and re-embed everything

### ingest
- `text` — store inline text
- `file` — read file from disk and store

### procedures
- `list` — list registered procedures
- `run` — run a named procedure
