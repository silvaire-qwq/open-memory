import * as Memory from "./memory.js";
import React, { useState, useEffect, useRef } from "react";
import { render, Text, Box, useInput, useApp } from "ink";
import type { Engram } from "./types.js";

type Light = Omit<Engram, "embedding">;

const CAT_COLORS: Record<string, string> = {
  user: "#22d3ee", pref: "#22d3ee",
  chat: "#facc15", summary: "#facc15",
  post: "#4ade80", blog: "#4ade80",
  tool: "#60a5fa",
  corr: "#f97316",
  file: "#a78bfa", inventory: "#a78bfa",
  fact: "#e4e4e7",
};

function catColor(c: string): string {
  for (const [k, v] of Object.entries(CAT_COLORS)) if (c.includes(k)) return v;
  return "#e4e4e7";
}

function impColor(v: number): string {
  if (v >= 0.9) return "#f87171";
  if (v >= 0.5) return "#fbbf24";
  return "#6ee7b7";
}

function firstLine(s: string): string {
  const l = s.split("\n")[0]!.trim();
  return l.replace(/^---$/, "").replace(/^title:\s*/i, "").substring(0, 80);
}

function strip(e: Engram): Light {
  const { embedding: _, ...r } = e;
  return r;
}

type Screen = "list" | "search" | "detail" | "create" | "confirm";

function SearchInput({ value }: { value: string }) {
  return React.createElement(Box, { height: 1, paddingX: 2 },
    React.createElement(Text, { bold: true, color: "#6366f1" }, "  / "),
    React.createElement(Text, { color: "#e4e4e7" }, value || ""),
    value.length % 2 === 0 ? React.createElement(Text, { color: "#6366f1" }, "█") : React.createElement(Text, { color: "#e4e4e7" }, " "),
  );
}

function CreateForm({
  content, cat, imp, tags, focus,
  onContent, onCat, onImp, onTags,
}: {
  content: string; cat: string; imp: string; tags: string; focus: number;
  onContent: (s: string) => void; onCat: (s: string) => void; onImp: (s: string) => void; onTags: (s: string) => void;
}) {
  const fields = [
    { label: "Content", val: content, set: onContent },
    { label: "Category", val: cat, set: onCat },
    { label: "Importance", val: imp, set: onImp },
    { label: "Tags", val: tags, set: onTags },
  ];

  return React.createElement(Box, { flexDirection: "column", paddingX: 2, paddingY: 1 },
    React.createElement(Text, { bold: true, underline: true }, "  New Memory"),
    React.createElement(Box, { height: 1, marginTop: 1 }),
    ...fields.map((f, i) =>
      React.createElement(Box, { key: f.label, height: 1 },
        React.createElement(Text, { inverse: i === focus },
          `  ${f.label}: ${f.val || (i === 0 ? "(required)" : "")}`,
        ),
      ),
    ),
    React.createElement(Box, { height: 1 }),
    React.createElement(Text, { color: "#52525b" },
      "  [Tab] next  [Enter] save when Tags is focused  [Esc] cancel",
    ),
  );
}

function ConfirmDialog({ msg }: { msg: string }) {
  return React.createElement(Box, { paddingX: 2, paddingY: 2 },
    React.createElement(Box, {
      borderStyle: "single",
      borderColor: "#ef4444",
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
    },
      React.createElement(Text, { color: "#fca5a5" }, `  ${msg}`),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "#f87171" }, "  (y)es  (n)o"),
    ),
  );
}

function DetailView({ item }: { item: Light }) {
  const cols = 76;
  return React.createElement(Box, {
    borderStyle: "round",
    borderColor: "#6366f1",
    paddingX: 1,
    paddingY: 1,
    flexDirection: "column",
    marginX: 1,
  },
    React.createElement(Text, { bold: true }, `  Memory #${item.id}`),
    React.createElement(Box, {
      marginY: 1,
      borderStyle: "single",
      borderColor: "#27272a",
      paddingX: 1,
      height: 8,
      flexDirection: "column",
      overflowY: "hidden",
    },
      item.content.split("\n").slice(0, 6).map((l, i) =>
        React.createElement(Text, { key: i, wrap: "truncate" },
          l.substring(0, cols),
        ),
      ),
    ),
    React.createElement(Text, null, `  Category  `, React.createElement(Text, { color: catColor(item.category) }, item.category)),
    React.createElement(Text, null, `  Importance  ${(item.importance * 100).toFixed(0)}%`),
    React.createElement(Text, null, `  Project  ${item.project_id}`),
    React.createElement(Text, null, `  Created  ${item.created_at || "?"}`),
    item.tags?.length ? React.createElement(Text, null, `  Tags  ${item.tags.join(", ")}`) : null,
    item.location ? React.createElement(Text, null, `  Location  ${item.location}`) : null,
    React.createElement(Box, { marginTop: 1 }),
    React.createElement(Text, { color: "#52525b" },
      "  [Esc] back  [d] delete  [q] quit",
    ),
  );
}

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
  const [items, setItems] = useState<Light[]>([]);
  const [idx, setIdx] = useState(0);
  const [screen, setScreen] = useState<Screen>("list");
  const [detail, setDetail] = useState<Light | null>(null);

  // Search
  const [sq, setSq] = useState("");
  // Create
  const [cc, setCc] = useState("");
  const [cCat, setCCat] = useState("fact");
  const [cImp, setCImp] = useState("0.5");
  const [cTags, setCTags] = useState("");
  const [cFocus, setCFocus] = useState(0);
  // Confirm
  const [confirmMsg, setConfirmMsg] = useState("");
  const [confirmCb, setConfirmCb] = useState<(() => void) | null>(null);

  function load(q?: string) {
    const r = q
      ? Memory.search(db, q, { limit: 200, min_similarity: 0 })
      : Memory.list(db, { limit: 500 });
    setItems(r.map(strip));
    setIdx(0);
  }

  useEffect(() => { load(); }, []);

  function msg(s: string) {
    // unused for now
  }

  useInput((input, key) => {
    switch (screen) {
      case "detail":
        if (key.escape) { setScreen("list"); setDetail(null); return; }
        if (input === "d" && detail) {
          setConfirmMsg(`Delete memory #${detail.id}: ${firstLine(detail.content).substring(0, 40)}?`);
          setConfirmCb(() => () => { Memory.softDelete(db, detail.id!); load(); msg("Deleted"); });
          setScreen("confirm");
        }
        return;

      case "confirm":
        if (input === "y" && confirmCb) confirmCb();
        setScreen("list");
        setDetail(null);
        return;

      case "search":
        if (key.escape) { setScreen("list"); setSq(""); load(); return; }
        if (key.return) { setScreen("list"); load(sq); return; }
        if (key.backspace || key.delete) { setSq(s => s.slice(0, -1)); return; }
        if (input && input.length === 1) setSq(s => s + input);
        return;

      case "create":
        if (key.escape) { setScreen("list"); return; }
        if (key.tab) { setCFocus(f => (f + 1) % 4); return; }
        if (key.return) {
          if (cFocus === 3) {
            const imp = parseFloat(cImp);
            Memory.store(db, cc, {
              category: cCat || "fact",
              importance: isNaN(imp) ? 0.5 : imp,
              tags: cTags.split(",").map(t => t.trim()).filter(Boolean),
            });
            load();
            setScreen("list");
            return;
          }
          setCFocus(f => (f + 1) % 4);
          return;
        }
        if (key.backspace || key.delete) {
          if (cFocus === 0) setCc(cc.slice(0, -1));
          else if (cFocus === 1) setCCat(cCat.slice(0, -1));
          else if (cFocus === 2) setCImp(cImp.slice(0, -1));
          else if (cFocus === 3) setCTags(cTags.slice(0, -1));
          return;
        }
        if (input && input.length === 1) {
          if (cFocus === 0) setCc(cc + input);
          else if (cFocus === 1) setCCat(cCat + input);
          else if (cFocus === 2) setCImp(cImp + input);
          else if (cFocus === 3) setCTags(cTags + input);
        }
        return;
    }

    // List mode
    if (input === "q") process.exit(0);
    if (key.upArrow) setIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setIdx(i => Math.min(items.length - 1, i + 1));
    if (key.return && items[idx]) { setDetail(items[idx]!); setScreen("detail"); }
    if (input === "/") { setScreen("search"); setSq(""); }
    if (input === "n") { setCc(""); setCCat("fact"); setCImp("0.5"); setCTags(""); setCFocus(0); setScreen("create"); }
    if (input === "d" && items[idx]) {
      const m = items[idx]!;
      setConfirmMsg(`Delete memory #${m.id}: ${firstLine(m.content).substring(0, 40)}?`);
      setConfirmCb(() => () => { Memory.softDelete(db, m.id); load(); msg("Deleted"); });
      setScreen("confirm");
    }
    if (input === "r") load();
  });

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Title bar
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1", paddingX: 2 },
      React.createElement(Text, { bold: true, color: "white" }, "OpenMemory"),
      React.createElement(Text, { color: "#c7d2fe" }, "  tui"),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { color: "#e0e7ff" }, `${items.length} memories`),
    ),

    // Search bar
    screen === "search"
      ? React.createElement(SearchInput, { value: sq })
      : null,

    // Detail view
    screen === "detail" && detail
      ? React.createElement(DetailView, { item: detail })
      : null,

    // Confirm dialog
    screen === "confirm"
      ? React.createElement(ConfirmDialog, { msg: confirmMsg })
      : null,

    // Create form
    screen === "create"
      ? React.createElement(CreateForm, {
          content: cc, cat: cCat, imp: cImp, tags: cTags, focus: cFocus,
          onContent: setCc, onCat: setCCat, onImp: setCImp, onTags: setCTags,
        })
      : null,

    // List
    screen === "list" || screen === "search"
      ? React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1 },
          items.length === 0
            ? React.createElement(Box, { paddingY: 2, paddingX: 2 },
                React.createElement(Text, { color: "#52525b" }, "No memories found."),
              )
            : items.map((item, i) => {
                const active = i === idx;
                const pct = (item.importance * 100).toFixed(0);
                const cat = item.category.substring(0, 10).padEnd(10);
                return React.createElement(Box, { key: item.id, height: 1 },
                  React.createElement(Text, { inverse: active, wrap: "truncate" },
                    `  `,
                    React.createElement(Text, { color: "#52525b" }, String(item.id).padStart(4)),
                    ` `,
                    React.createElement(Text, { color: impColor(item.importance) }, pct.padStart(2) + "%"),
                    ` `,
                    React.createElement(Text, { color: catColor(item.category) }, cat),
                    `  ${firstLine(item.content)}`,
                  ),
                );
              }),
        )
      : null,

    // Footer
    React.createElement(Box, { height: 1, backgroundColor: "#18181b", paddingX: 2 },
      React.createElement(Text, { color: "#52525b" },
        `↑↓ nav  ↵ open  / search  n new  d delete  r refresh  q quit`,
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
