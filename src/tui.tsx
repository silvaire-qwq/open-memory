import * as Memory from "./memory.js";
import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput } from "ink";
import type { Engram } from "./types.js";

interface Item {
  id: number;
  percentage: string;
  category: string;
  content: string;
}

function toItems(rows: Omit<Engram, "embedding">[]): Item[] {
  return rows.map(e => ({
    id: e.id,
    percentage: (e.importance * 100).toFixed(0) + "%",
    category: e.category,
    content: e.content.split("\n")[0]!.trim().replace(/^---$/, "").replace(/^title:\s*/i, ""),
  }));
}

function catC(c: string): string {
  if (c.startsWith("user") || c.startsWith("pref")) return "#22d3ee";
  if (c.startsWith("chat")) return "#facc15";
  if (c.startsWith("post") || c.startsWith("blog")) return "#4ade80";
  if (c.startsWith("tool")) return "#60a5fa";
  if (c.startsWith("corr")) return "#f97316";
  if (c.startsWith("file")) return "#a78bfa";
  return "#e4e4e7";
}

function pctC(p: string): string {
  const v = parseInt(p, 10);
  if (v >= 90) return "#f87171";
  if (v >= 50) return "#fbbf24";
  return "#6ee7b7";
}

// ─── ListView ───────────────────────────────────────────────

function ListView({ items, selectedIndex }: { items: Item[]; selectedIndex: number }) {
  if (items.length === 0) {
    return React.createElement(Box, { paddingY: 1, paddingX: 2 },
      React.createElement(Text, { color: "#52525b" }, "No memories."),
    );
  }

  return React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1 },
    items.map((item, i) => {
      const active = i === selectedIndex;
      return React.createElement(Box, { key: item.id, height: 1 },
        React.createElement(Text, { inverse: active, wrap: "truncate" },
          " ",
          React.createElement(Text, { color: "#52525b" }, String(item.id).padStart(4)),
          " ",
          React.createElement(Text, { color: pctC(item.percentage) }, item.percentage.padStart(3)),
          " ",
          React.createElement(Text, { color: catC(item.category) }, item.category.substring(0, 10).padEnd(10)),
          "  ",
          item.content,
        ),
      );
    }),
  );
}

// ─── StatusBar ──────────────────────────────────────────────

function StatusBar({ count }: { count: number }) {
  return React.createElement(Box, { height: 1, backgroundColor: "#18181b", paddingX: 2 },
    React.createElement(Text, { color: "#71717a" },
      `${count} mem  │ ↑↓ nav  ↵ open  / search  n new  d del  r ref  q quit`,
    ),
  );
}

// ─── App ────────────────────────────────────────────────────

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  function load(q?: string) {
    const rows = q
      ? Memory.search(db, q, { limit: 200, min_similarity: 0 })
      : Memory.list(db, { limit: 500 });
    setItems(toItems(rows.map(r => { const { embedding: _, ...rest } = r; return rest; })));
    setSelectedIndex(0);
  }

  useEffect(() => { load(); }, []);

  useInput((input, key) => {
    if (input === "q") process.exit(0);
    if (key.upArrow) setSelectedIndex(i => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex(i => Math.min(items.length - 1, i + 1));
    if (input === "r") load();
    if (input === "d" && items[selectedIndex]) {
      Memory.softDelete(db, items[selectedIndex]!.id);
      load();
    }
  });

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1", paddingX: 2 },
      React.createElement(Text, { bold: true, color: "white" }, "OpenMemory"),
    ),
    React.createElement(ListView, { items, selectedIndex }),
    React.createElement(StatusBar, { count: items.length }),
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
