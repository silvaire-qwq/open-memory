import * as Memory from "./memory.js";
import React from "react";
import { render, Text, Box, useInput, useStdout } from "ink";
import type { Engram } from "./types.js";

type Light = Omit<Engram, "embedding">;

function strip(e: Engram): Light {
  const { embedding: _, ...r } = e;
  return r;
}

function preview(s: string, max: number): string {
  const l = s.split("\n")[0]!.trim().replace(/^---$/, "").replace(/^title:\s*/i, "");
  return l.length <= max ? l : l.substring(0, max - 1) + "…";
}

function catColor(cat: string): string {
  if (cat.includes("user") || cat.includes("pref")) return "#22d3ee";
  if (cat.includes("chat")) return "#facc15";
  if (cat.includes("post") || cat.includes("blog")) return "#4ade80";
  if (cat.includes("tool")) return "#60a5fa";
  return "#e4e4e7";
}

type View = "list" | "detail" | "create" | "confirm";

function App({ db }: { db: Database }) {
  const [memories, setMemories] = React.useState<Light[]>([]);
  const [cursor, setCursor] = React.useState(0);
  const [view, setView] = React.useState<View>("list");
  const [search, setSearch] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [searchBuf, setSearchBuf] = React.useState("");
  const [detail, setDetail] = React.useState<Light | null>(null);
  const [confirmMsg, setConfirmMsg] = React.useState("");
  const [confirmCb, setConfirmCb] = React.useState<(() => void) | null>(null);
  const [status, setStatus] = React.useState("");
  const [statusT, setStatusT] = React.useState(0);

  // Create form state
  const [cContent, setCContent] = React.useState("");
  const [cCat, setCCat] = React.useState("fact");
  const [cImp, setCImp] = React.useState("0.5");
  const [cTags, setCTags] = React.useState("");
  const [cField, setCField] = React.useState(0);

  const { stdout } = useStdout();
  const cols = stdout.columns || 80;

  function load(q?: string) {
    if (q) {
      setMemories(Memory.search(db, q, { limit: 200, min_similarity: 0 }).map(strip));
      return;
    }
    setMemories(Memory.list(db, { limit: 500 }).map(strip));
  }

  function msg(s: string) { setStatus(s); setStatusT(Date.now()); }

  React.useEffect(() => { load(); }, []);

  // Status timeout
  React.useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(""), 3000);
    return () => clearTimeout(t);
  }, [status, statusT]);

  const headerText = ` OpenMemory${searching ? "  🔍 " + searchBuf : ""}`;

  useInput((input, key) => {
    if (view === "detail" && detail) {
      if (key.escape) { setView("list"); setDetail(null); return; }
      if (input === "d") {
        setConfirmMsg(`Delete memory #${detail.id}?`);
        setConfirmCb(() => () => { Memory.softDelete(db, detail.id); load(search || undefined); msg(`Deleted #${detail.id}`); });
        setView("confirm");
      }
      return;
    }

    if (view === "confirm") {
      if (input === "y" && confirmCb) { confirmCb(); }
      setView("list");
      return;
    }

    if (view === "create") {
      if (key.escape) { setView("list"); return; }
      if (key.tab) { setCField((cField + 1) % 4); return; }
      if (key.return) {
        if (cField === 3) {
          const imp = parseFloat(cImp);
          const r = Memory.store(db, cContent, {
            category: cCat || "fact",
            importance: isNaN(imp) ? 0.5 : imp,
            tags: cTags.split(",").map(t => t.trim()).filter(Boolean),
          });
          if (r.ok) { msg(`Stored #${r.id}`); load(); }
          else { msg("Failed: " + r.reason); }
          setView("list");
          return;
        }
        setCField((cField + 1) % 4);
        return;
      }
      if (key.backspace || key.delete) {
        if (cField === 0) setCContent(cContent.slice(0, -1));
        else if (cField === 1) setCCat(cCat.slice(0, -1));
        else if (cField === 2) setCImp(cImp.slice(0, -1));
        else if (cField === 3) setCTags(cTags.slice(0, -1));
        return;
      }
      if (input && input.length === 1) {
        if (cField === 0) setCContent(cContent + input);
        else if (cField === 1) setCCat(cCat + input);
        else if (cField === 2) setCImp(cImp + input);
        else if (cField === 3) setCTags(cTags + input);
      }
      return;
    }

    if (searching) {
      if (key.escape) { setSearching(false); setSearchBuf(""); load(); return; }
      if (key.return) { setSearch(searchBuf); setSearching(false); load(searchBuf); return; }
      if (key.backspace || key.delete) { setSearchBuf(searchBuf.slice(0, -1)); return; }
      if (input && input.length === 1) { setSearchBuf(searchBuf + input); }
      return;
    }

    // List mode
    if (input === "q") process.exit(0);
    if (key.upArrow && cursor > 0) setCursor(cursor - 1);
    if (key.downArrow && cursor < memories.length - 1) setCursor(cursor + 1);
    if (key.pageUp) setCursor(Math.max(0, cursor - Math.floor(stdout.rows! * 0.6)));
    if (key.pageDown) setCursor(Math.min(memories.length - 1, cursor + Math.floor(stdout.rows! * 0.6)));
    if (key.return && memories[cursor]) { setDetail(memories[cursor]!); setView("detail"); }
    if (input === "/") { setSearching(true); setSearchBuf(""); }
    if (input === "n") {
      setCContent(""); setCCat("fact"); setCImp("0.5"); setCTags(""); setCField(0);
      setView("create");
    }
    if (input === "d" && memories[cursor]) {
      const m = memories[cursor]!;
      setConfirmMsg(`Delete memory #${m.id}?`);
      setConfirmCb(() => () => { Memory.softDelete(db, m.id); load(search || undefined); msg(`Deleted #${m.id}`); });
      setView("confirm");
    }
    if (input === "r") { load(search || undefined); msg("Refreshed"); }
  });

  const rows = Math.max(stdout.rows! - 5, 5);
  const maxOff = Math.max(0, memories.length - rows);
  const offset = Math.min(maxOff, Math.max(0, cursor - Math.floor(rows / 2)));
  const vis = memories.slice(offset, offset + rows);

  const r = 255; // key

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Header
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1" },
      React.createElement(Text, { bold: true, color: "white" }, headerText),
    ),
    // Status
    status ? React.createElement(Box, { height: 1 },
      React.createElement(Text, { color: "#4ade80" }, ` ${status}`),
    ) : null,
    // Search
    searching ? React.createElement(Box, { height: 1, paddingLeft: 1 },
      React.createElement(Text, null, `Search: ${searchBuf}`),
    ) : null,

    // Main content
    view === "detail" && detail ? React.createElement(Box, { flexDirection: "column", paddingX: 1, overflowY: "auto" as const },
      React.createElement(Text, { bold: true }, ` Memory #${detail.id}`),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: "#71717a" }, ` ${detail.content.split("\n").slice(0, 50).join("\n ")}`),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, null, ` Category: `, React.createElement(Text, { color: catColor(detail.category) }, detail.category)),
      React.createElement(Text, null, ` Importance: ${(detail.importance * 100).toFixed(0)}%`),
      React.createElement(Text, null, ` Project: ${detail.project_id}`),
      React.createElement(Text, null, ` Created: ${detail.created_at || "?"}`),
      detail.tags?.length ? React.createElement(Text, null, ` Tags: ${detail.tags.join(", ")}`) : null,
      detail.location ? React.createElement(Text, null, ` Location: ${detail.location}`) : null,
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { dimColor: true }, " [Esc] back  [d] delete"),
    ) :

    view === "confirm" ? React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: "#ef4444" }, ` ${confirmMsg}  (y/n)`),
    ) :

    view === "create" ? React.createElement(Box, { flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { bold: true }, " New Memory  [Tab]next  [Enter]save  [Esc]cancel"),
      React.createElement(Box, { height: 1 }),
      ...[
        { label: "Content", val: cContent },
        { label: "Category", val: cCat },
        { label: "Importance", val: cImp },
        { label: "Tags", val: cTags },
      ].map((f, i) =>
        React.createElement(Box, { key: f.label },
          React.createElement(Text, { inverse: i === cField }, ` ${f.label}: `),
          React.createElement(Text, { inverse: i === cField }, f.val || (i === 0 ? "(required)" : "")),
        )
      ),
      React.createElement(Text, { dimColor: true }, " Tab to switch, Enter to save, Esc to cancel"),
    ) :

    // List
    React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
      vis.length === 0 ?
        React.createElement(Box, { paddingX: 1 },
          React.createElement(Text, { color: "#52525b" }, " No memories found"),
        ) :
        vis.map((m, i) => {
          const idx = offset + i;
          const cur = idx === cursor;
          const imp = (m.importance * 100).toFixed(0).padStart(2);
          const cat = m.category.substring(0, 12).padEnd(12);
          const body = preview(m.content, Math.max(cols - 40, 20));
          return React.createElement(Box, { key: m.id },
            React.createElement(Text, { inverse: cur },
              ` ${String(m.id).padStart(4)} ${imp}% `,
              React.createElement(Text, { color: catColor(m.category) }, cat),
              ` ${body}`,
            ),
          );
        }),
    ),

    // Footer
    React.createElement(Box, { height: 1, backgroundColor: "#18181b" },
      React.createElement(Text, { color: "#71717a" },
        ` ${memories.length} memories`,
        search ? `  🔍 ${search}` : "",
      ),
    ),
  );
}

export function startTui(db: import("bun:sqlite").Database): void {
  const { waitUntilExit } = render(React.createElement(App, { db }));
  waitUntilExit();
}

// Standalone entry point
if (import.meta.main) {
  const dbPath = process.env.OPENMEMORY_DB_PATH;
  if (!dbPath) { process.stderr.write("OPENMEMORY_DB_PATH not set\n"); process.exit(1); }
  const db = Memory.openDb(dbPath);
  startTui(db);
}
