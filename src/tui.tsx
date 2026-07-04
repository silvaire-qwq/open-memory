import * as Memory from "./memory.js";
import React from "react";
import { render, Text, Box, useInput, useStdout } from "ink";
import type { Engram } from "./types.js";

interface Item {
  id: number;
  percentage: string;
  category: string;
  content: string;
}

function toItems(raw: Omit<Engram, "embedding">[]): Item[] {
  return raw.map(e => ({
    id: e.id,
    percentage: (e.importance * 100).toFixed(0) + "%",
    category: e.category,
    content: preview(e.content),
  }));
}

function preview(s: string): string {
  const line = s.split("\n")[0]!.trim();
  return line.replace(/^---$/, "").replace(/^title:\s*/i, "");
}

function visLen(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    w += c > 0x2e80 && c < 0x30000 ? 2 : 1;
  }
  return w;
}

function trunc(s: string, n: number): string {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    const wc = c > 0x2e80 && c < 0x30000 ? 2 : 1;
    if (w + wc > n - 1) return s.substring(0, Math.max(0, i)) + "…";
    w += wc;
  }
  return s;
}

const CAT_COLORS: Record<string, string> = {
  user: "#22d3ee", pref: "#22d3ee",
  chat: "#facc15",
  post: "#4ade80", blog: "#4ade80", tool: "#60a5fa",
  corr: "#f97316",
  file: "#a78bfa", inventory: "#a78bfa",
};

function catColor(cat: string): string {
  for (const [k, v] of Object.entries(CAT_COLORS)) {
    if (cat.includes(k)) return v;
  }
  return "#e4e4e7";
}

function pctColor(pct: string): string {
  const v = parseInt(pct, 10);
  if (v >= 90) return "#f87171";
  if (v >= 50) return "#fbbf24";
  return "#6ee7b7";
}

// ─── ListView ───────────────────────────────────────────────

function ListView({ items, selectedIndex }: { items: Item[]; selectedIndex: number }) {
  const { stdout } = useStdout();
  const termW = Math.min(stdout.columns || 80, 80);
  const idW = 5;
  const pctW = 4;
  const catW = 12;
  const cw = termW - idW - pctW - catW - 3;

  return React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
    items.length === 0
      ? React.createElement(Box, { paddingY: 1 },
          React.createElement(Text, { color: "#52525b" }, "  No memories.  [/] search  [n] new"),
        )
      : items.map((item, i) => {
          const active = i === selectedIndex;
          const body = trunc(item.content, cw);
          return React.createElement(Box, { key: item.id, height: 1 },
            React.createElement(Text, { inverse: active, wrap: "truncate" },
              " ",
              React.createElement(Text, { color: "#52525b" }, String(item.id).padStart(4)),
              " ",
              React.createElement(Text, { color: pctColor(item.percentage) }, item.percentage.padStart(3)),
              " ",
              React.createElement(Text, { color: catColor(item.category) }, item.category.substring(0, 10).padEnd(10)),
              " ",
              body,
            ),
          );
        }),
  );
}

// ─── StatusBar ──────────────────────────────────────────────

function StatusBar({ count, searchQuery }: { count: number; searchQuery: string }) {
  return React.createElement(Box, { height: 1, backgroundColor: "#18181b" },
    React.createElement(Text, { color: "#71717a" },
      `  ${count} mem  │ ↑↓ nav  │ ↵ open  │ / search  │ n new  │ d del  │ r ref  │ q quit`,
    ),
  );
}

// ─── App ────────────────────────────────────────────────────

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
  const [items, setItems] = React.useState<Item[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);

  function load(q?: string) {
    const raw = q
      ? Memory.search(db, q, { limit: 200, min_similarity: 0 })
      : Memory.list(db, { limit: 500 });
    setItems(toItems(raw.map(e => {
      const { embedding: _, ...rest } = e;
      return rest;
    })));
    setSelectedIndex(0);
  }

  React.useEffect(() => { load(); }, []);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) { setSearching(false); setSearchQuery(""); load(); return; }
      if (key.return) { setSearching(false); load(searchQuery); return; }
      if (key.backspace || key.delete) { setSearchQuery(q => q.slice(0, -1)); return; }
      if (input && input.length === 1) setSearchQuery(q => q + input);
      return;
    }

    switch (true) {
      case input === "q":
        process.exit(0);
        break;
      case key.upArrow:
        setSelectedIndex(i => Math.max(0, i - 1));
        break;
      case key.downArrow:
        setSelectedIndex(i => Math.min(items.length - 1, i + 1));
        break;
      case key.return:
        // open detail — to be implemented
        break;
      case input === "/":
        setSearching(true);
        setSearchQuery("");
        break;
      case input === "n":
        // new memory — to be implemented
        break;
      case input === "d":
        if (items[selectedIndex]) {
          Memory.softDelete(db, items[selectedIndex]!.id);
          load();
        }
        break;
      case input === "r":
        load();
        break;
    }
  });

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Title bar
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1" },
      React.createElement(Text, { bold: true, color: "white" }, " OpenMemory"),
      React.createElement(Text, { color: "#c7d2fe" }, "  tui"),
      searching
        ? React.createElement(Text, { color: "#fef08a" }, `  search: ${searchQuery}`)
        : null,
    ),
    // List
    React.createElement(ListView, { items, selectedIndex }),
    // Status bar
    React.createElement(StatusBar, { count: items.length, searchQuery }),
  );
}

// ─── Entry ──────────────────────────────────────────────────

export function startTui(db: ReturnType<typeof Memory.openDb>): void {
  const { waitUntilExit } = render(React.createElement(App, { db }));
  waitUntilExit();
}

if (import.meta.main) {
  const dbPath = process.env.OPENMEMORY_DB_PATH;
  if (!dbPath) { process.stderr.write("OPENMEMORY_DB_PATH not set\n"); process.exit(1); }
  const db = Memory.openDb(dbPath);
  startTui(db);
}
