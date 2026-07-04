import * as Memory from "./memory.js";
import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput } from "ink";
import type { Engram } from "./types.js";

type Item = Omit<Engram, "embedding">;

function line(s: string): string {
  const l = s.split("\n")[0]!.trim();
  return l.replace(/^---$/, "").replace(/^title:\s*/i, "");
}

const CAT: Record<string, string> = {
  user: "#22d3ee", pref: "#22d3ee",
  chat: "#facc15",
  post: "#4ade80", blog: "#4ade80",
  tool: "#60a5fa",
  corr: "#f97316",
  file: "#a78bfa", inventory: "#a78bfa",
};

function cc(c: string): string {
  for (const [k, v] of Object.entries(CAT)) if (c.includes(k)) return v;
  return "#e4e4e7";
}

function pc(v: number): string {
  if (v >= 0.9) return "#f87171";
  if (v >= 0.5) return "#fbbf24";
  return "#6ee7b7";
}

function SearchBar({ value }: { value: string }) {
  return React.createElement(Box, { height: 1, paddingX: 2, marginBottom: 1 },
    React.createElement(Text, { color: "#6366f1", bold: true }, "  ＞ "),
    React.createElement(Text, { color: value ? "#e4e4e7" : "#52525b" },
      value || "Search memories...",
    ),
  );
}

function MemoryRow({ item, active }: { item: Item; active: boolean }) {
  const pct = (item.importance * 100).toFixed(0);
  const cat = item.category.substring(0, 10);

  return React.createElement(Box, { height: 1 },
    React.createElement(Text, { inverse: active, wrap: "truncate" },
      active ? "  " : "  ",
      React.createElement(Text, { color: "#52525b" }, String(item.id).padStart(4)),
      " ",
      React.createElement(Text, { color: pc(item.importance) }, pct.padStart(2) + "%"),
      " ",
      React.createElement(Text, { color: cc(item.category) }, cat.padEnd(10)),
      "  ",
      line(item.content),
    ),
  );
}

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
  const [items, setItems] = useState<Item[]>([]);
  const [idx, setIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"list" | "search">("list");

  function load(q?: string) {
    const r = q
      ? Memory.search(db, q, { limit: 200, min_similarity: 0 })
      : Memory.list(db, { limit: 500 });
    setItems(r.map(e => { const { embedding: _, ...rest } = e; return rest; }));
    setIdx(0);
  }

  useEffect(() => { load(); }, []);

  useInput((input, key) => {
    if (mode === "search") {
      if (key.escape) { setMode("list"); setSearch(""); load(); return; }
      if (key.return) { setMode("list"); load(search); return; }
      if (key.backspace || key.delete) { setSearch(s => s.slice(0, -1)); return; }
      if (input && input.length === 1) setSearch(s => s + input);
      return;
    }

    if (input === "q") process.exit(0);
    if (key.upArrow) setIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setIdx(i => Math.min(items.length - 1, i + 1));
    if (input === "/") { setMode("search"); setSearch(""); }
    if (input === "r") load();
    if (input === "d" && items[idx]) { Memory.softDelete(db, items[idx]!.id); load(); }
    if (input === "n") {
      Memory.store(db, "new memory", { category: "fact", importance: 0.5 });
      load();
    }
  });

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Title bar
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1", paddingX: 2 },
      React.createElement(Text, { bold: true, color: "white" }, "OpenMemory"),
      React.createElement(Text, { color: "#c7d2fe" }, "  tui"),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { color: "#e0e7ff" }, `${items.length} memories`),
    ),

    // Search
    mode === "search"
      ? React.createElement(SearchBar, { value: search })
      : React.createElement(Box, { height: 1, paddingX: 2, marginBottom: 1 },
          React.createElement(Text, { color: "#52525b" }, "  Press / to search"),
        ),

    // List
    React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1, gap: 0 },
      items.length === 0
        ? React.createElement(Box, { paddingY: 2, paddingX: 2 },
            React.createElement(Text, { color: "#52525b" }, "No memories found."),
          )
        : items.map((item, i) =>
            React.createElement(MemoryRow, { key: item.id, item, active: i === idx }),
          ),
    ),

    // Footer
    React.createElement(Box, { height: 1, backgroundColor: "#18181b", paddingX: 2 },
      React.createElement(Text, { color: "#52525b" },
        "↑↓ nav  ↵ open  / search  n new  d delete  r refresh  q quit",
      ),
    ),
  );
}

export function startTui(db: ReturnType<typeof Memory.openDb>): void {
  const { waitUntilExit } = render(React.createElement(App, { db }));
  waitUntilExit();
}

if (import.meta.main) {
  const p = process.env.OPENMEMORY_DB_PATH;
  if (!p) { process.stderr.write("OPENMEMORY_DB_PATH not set\n"); process.exit(1); }
  startTui(Memory.openDb(p));
}
