import * as Memory from "./memory.js";
import React from "react";
import { render, Text, Box, useInput, useStdout } from "ink";
import type { Engram } from "./types.js";

type Light = Omit<Engram, "embedding">;

const COLORS: Record<string, string> = {
  user: "#22d3ee", pref: "#22d3ee",
  chat: "#facc15",
  post: "#4ade80", blog: "#4ade80",
  tool: "#60a5fa",
  corr: "#f97316",
  file: "#a78bfa", inventory: "#a78bfa",
};

function cc(cat: string): string {
  for (const [k, v] of Object.entries(COLORS)) {
    if (cat.includes(k)) return v;
  }
  return "#e4e4e7";
}

function ic(v: number): string {
  if (v >= 0.9) return "#f87171";
  if (v >= 0.5) return "#fbbf24";
  return "#6ee7b7";
}

function first(s: string): string {
  return s.split("\n")[0]!.trim().replace(/^---$/, "").replace(/^title:\s*/i, "");
}

function trunc(s: string, n: number): string {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    const wc = c > 0x2e80 && c < 0x30000 ? 2 : 1;
    if (w + wc > n - 1) return s.substring(0, i) + "…";
    w += wc;
  }
  return s;
}

type V = "list" | "detail" | "create" | "confirm";

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
  const [items, setItems] = React.useState<Light[]>([]);
  const [cur, setCur] = React.useState(0);
  const [view, setView] = React.useState<V>("list");
  const [sb, setSb] = React.useState("");
  const [sa, setSa] = React.useState(false);
  const [det, setDet] = React.useState<Light | null>(null);
  const [cmsg, setCmsg] = React.useState("");
  const [ccb, setCcb] = React.useState<(() => void) | null>(null);

  const [tx, setTx] = React.useState("");
  const [tc, setTc] = React.useState("fact");
  const [ti, setTi] = React.useState("0.5");
  const [tt, setTt] = React.useState("");
  const [tf, setTf] = React.useState(0);

  const { stdout } = useStdout();
  const w = Math.min(stdout.columns || 80, 80);

  const ld = (q?: string) => {
    if (q) { setItems(Memory.search(db, q, { limit: 200, min_similarity: 0 }).map(e => { const { embedding: _, ...r } = e; return r; })); return; }
    setItems(Memory.list(db, { limit: 500 }).map(e => { const { embedding: _, ...r } = e; return r; }));
    setCur(0);
  };

  React.useEffect(() => { ld(); }, []);

  useInput((input, key) => {
    if (view === "detail" && det) {
      if (key.escape) { setView("list"); return; }
      if (input === "d") { setCmsg(`Delete #${det.id}?`); setCcb(() => () => { Memory.softDelete(db, det.id); ld(); }); setView("confirm"); }
      return;
    }
    if (view === "confirm") {
      if (input === "y" && ccb) ccb();
      setView("list"); return;
    }
    if (view === "create") {
      if (key.escape) { setView("list"); return; }
      if (key.tab) { setTf((tf + 1) % 4); return; }
      if (key.return) {
        if (tf === 3) {
          const imp = parseFloat(ti);
          Memory.store(db, tx, { category: tc || "fact", importance: isNaN(imp) ? 0.5 : imp, tags: tt.split(",").map(t => t.trim()).filter(Boolean) });
          ld(); setView("list"); return;
        }
        setTf((tf + 1) % 4); return;
      }
      if (key.backspace || key.delete) {
        if (tf === 0) setTx(tx.slice(0, -1));
        else if (tf === 1) setTc(tc.slice(0, -1));
        else if (tf === 2) setTi(ti.slice(0, -1));
        else if (tf === 3) setTt(tt.slice(0, -1));
        return;
      }
      if (input && input.length === 1) {
        if (tf === 0) setTx(tx + input);
        else if (tf === 1) setTc(tc + input);
        else if (tf === 2) setTi(ti + input);
        else if (tf === 3) setTt(tt + input);
      }
      return;
    }
    if (sa) {
      if (key.escape) { setSa(false); setSb(""); ld(); return; }
      if (key.return) { setSa(false); ld(sb); return; }
      if (key.backspace || key.delete) { setSb(sb.slice(0, -1)); return; }
      if (input && input.length === 1) setSb(sb + input);
      return;
    }
    if (input === "q") process.exit(0);
    if (key.upArrow && cur > 0) setCur(cur - 1);
    if (key.downArrow && cur < items.length - 1) setCur(cur + 1);
    if (key.return && items[cur]) { setDet(items[cur]!); setView("detail"); }
    if (input === "/") setSa(true);
    if (input === "n") { setTx(""); setTc("fact"); setTi("0.5"); setTt(""); setTf(0); setView("create"); }
    if (input === "d" && items[cur]) { setCmsg(`Delete #${items[cur]!.id}?`); setCcb(() => () => { Memory.softDelete(db, items[cur]!.id); ld(); }); setView("confirm"); }
    if (input === "r") ld();
  });

  const cw = w - 24;

  return React.createElement(Box, { flexDirection: "column", width: w },
    // Title
    React.createElement(Box, { height: 1, backgroundColor: "#6366f1" },
      React.createElement(Text, { bold: true, color: "white" }, " OpenMemory TUI"),
      sa ? React.createElement(Text, { color: "#fef08a" }, `  search: ${sb}`) : null,
    ),

    view === "detail" && det ? React.createElement(Box, { paddingX: 1 },
      React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "#6366f1", paddingX: 1, paddingY: 1, width: w - 2 },
        React.createElement(Text, { bold: true }, `Memory #${det.id}`),
        React.createElement(Box, { marginY: 1, borderStyle: "single", borderColor: "#27272a", paddingX: 1, height: 10 },
          React.createElement(Text, null, det.content.split("\n").slice(0, 8).join("\n")),
        ),
        React.createElement(Text, null, `Category: `, React.createElement(Text, { color: cc(det.category) }, det.category)),
        React.createElement(Text, null, `Importance: ${(det.importance * 100).toFixed(0)}%`),
        React.createElement(Text, null, `Created: ${det.created_at || "?"}`),
        det.tags?.length ? React.createElement(Text, null, `Tags: ${det.tags.join(", ")}`) : null,
        React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { dimColor: true }, "[Esc] back  [d] delete"),
        ),
      ),
    ) : null,

    view === "confirm" ? React.createElement(Box, { paddingX: 2, paddingY: 1 },
      React.createElement(Box, { borderStyle: "round", borderColor: "#ef4444", paddingX: 2, height: 3, alignItems: "center" },
        React.createElement(Text, { color: "#ef4444" }, cmsg, " ", React.createElement(Text, { color: "#fca5a5" }, "(y/n)")),
      ),
    ) : null,

    view === "create" ? React.createElement(Box, { paddingX: 1, flexDirection: "column" },
      React.createElement(Box, { borderStyle: "round", borderColor: "#6366f1", paddingX: 1, paddingY: 1, flexDirection: "column" },
        React.createElement(Text, { bold: true }, " New Memory"),
        [{ l: "Content", v: tx }, { l: "Category", v: tc }, { l: "Importance", v: ti }, { l: "Tags", v: tt }].map((f, i) =>
          React.createElement(Box, { key: f.l },
            React.createElement(Text, { inverse: i === tf }, ` ${f.l}: ${f.v || (i === 0 ? "(required)" : "")}`),
          )
        ),
      ),
      React.createElement(Text, { dimColor: true, marginTop: 1 }, " [Tab]next  [Enter]save  [Esc]cancel"),
    ) : null,

    // List
    view === "list" ? React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1 },
      items.length === 0 ?
        React.createElement(Box, { paddingY: 1 },
          React.createElement(Text, { color: "#52525b" }, "No memories. [/] search  [n] new"),
        ) :
        React.createElement(React.Fragment, null,
          items.map((m, i) => {
            const active = i === cur;
            const id = String(m.id).padStart(4);
            const imp = (m.importance * 100).toFixed(0).padStart(2);
            const cat = m.category.substring(0, 10).padEnd(10);
            const body = trunc(first(m.content), cw);
            return React.createElement(Box, { key: m.id, height: 1, width: w - 2 },
              React.createElement(Text, { inverse: active },
                ` ${id} `,
                React.createElement(Text, { color: ic(m.importance) }, imp),
                "% ",
                React.createElement(Text, { color: cc(m.category) }, cat),
                ` ${body}`,
              ),
            );
          }),
        )
    ) : null,

    // Footer
    React.createElement(Box, { height: 1, backgroundColor: "#18181b" },
      React.createElement(Text, { color: "#71717a" },
        ` ${items.length} mem  │ ↑↓ nav │ ↵ open │ / search │ n new │ d del │ r ref │ q quit`,
      ),
    ),
  );
}

export function startTui(db: ReturnType<typeof Memory.openDb>): void {
  const { waitUntilExit } = render(React.createElement(App, { db }));
  waitUntilExit();
}
