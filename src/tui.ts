import type { Database } from "bun:sqlite";
import * as Memory from "./memory.js";

const ESC = "\x1b";
const CSI = ESC + "[";
const CLEAR = CSI + "2J" + CSI + "H";
const HIDE = CSI + "?25l";
const SHOW = CSI + "?25h";
const RST = CSI + "0m";
const BOLD = CSI + "1m";
const DIM = CSI + "2m";
const REV = CSI + "7m";
const RED = CSI + "31m";
const GRN = CSI + "32m";
const YLW = CSI + "33m";
const BLU = CSI + "34m";
const MAG = CSI + "35m";
const CYN = CSI + "36m";
const WHT = CSI + "37m";

type EngramLight = Omit<Memory.Engram, "embedding">;
type Screen = "list" | "detail" | "confirm";
type InputMode = "none" | "search" | "createContent" | "createCategory" | "createImportance" | "createTags" | "confirm";

interface State {
  screen: Screen;
  memories: EngramLight[];
  cursor: number;
  offset: number;
  searchQuery: string;
  detailItem: EngramLight | null;
  confirmMsg: string;
  confirmAction: (() => void) | null;
  statusMsg: string;
  statusTime: number;
  newContent: string;
  newCategory: string;
  newImportance: string;
  newTags: string;
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.trim();
}

function preview(s: string, max: number): string {
  const line = firstLine(s);
  // Strip YAML frontmatter markers
  const clean = line.replace(/^---$/, "").replace(/^title:\s*/i, "");
  if (clean.length <= max) return clean;
  return clean.substring(0, max - 1) + "…";
}

function catColor(cat: string): string {
  if (cat.includes("user")) return CYN;
  if (cat.includes("pref")) return MAG;
  if (cat.includes("chat")) return YLW;
  if (cat.includes("post") || cat.includes("blog")) return GRN;
  if (cat.includes("tool")) return BLU;
  return WHT;
}

export function startTui(db: Database): void {
  const state: State = {
    screen: "list",
    memories: [],
    cursor: 0, offset: 0,
    searchQuery: "",
    detailItem: null,
    confirmMsg: "", confirmAction: null,
    statusMsg: "", statusTime: 0,
    newContent: "", newCategory: "fact", newImportance: "0.5", newTags: "",
  };

  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) { process.stderr.write("TTY required\n"); process.exit(1); }
  stdin.setRawMode?.(true);
  stdin.resume();

  let buf = "";
  let mode: InputMode = "none";

  function load() {
    const opts: Memory.ListOptions = { limit: 500 };
    if (state.searchQuery) {
      state.memories = Memory.search(db, state.searchQuery, { limit: 200, min_similarity: 0 }).map(strip);
    } else {
      state.memories = Memory.list(db, opts).map(strip);
    }
    state.cursor = 0; state.offset = 0;
  }

  function strip(e: Memory.Engram): EngramLight {
    const { embedding: _, ...rest } = e;
    return rest;
  }

  function msg(s: string) { state.statusMsg = s; state.statusTime = Date.now(); }

  function render() {
    stdout.write(CLEAR + HIDE);

    // ── Header bar ──
    stdout.write(BOLD + " OpenMemory " + RST + DIM + "TUI" + RST);
    stdout.write("  " + DIM);
    if (state.searchQuery) stdout.write("🔍 " + state.searchQuery + "  ");
    stdout.write("[↑↓]nav [↵]open [n]new [/]search [d]del [q]quit" + RST + "\n");

    if (state.statusMsg && Date.now() - state.statusTime < 3000) {
      stdout.write(" " + state.statusMsg + "\n");
    }
    stdout.write(" " + DIM + "─".repeat(Math.min(80, stdout.columns - 2)) + RST + "\n");

    // ── Mode routers ──
    if (mode.startsWith("create")) { renderCreate(); return; }
    if (mode === "search") {
      stdout.write(" Search: " + state.searchQuery + (state.searchQuery.length % 2 === 0 ? "█" : " ") + "\n\n");
    }
    if (state.screen === "confirm") {
      stdout.write("\n " + state.confirmMsg + "\n " + YLW + "(y/n)" + RST + " ");
      stdout.write(SHOW); return;
    }
    if (state.screen === "detail" && state.detailItem) { renderDetail(); return; }

    // ── List ──
    if (state.memories.length === 0) {
      stdout.write("\n No memories found.\n\n");
      stdout.write(" [n] New  [/] Search  [r] Refresh\n");
      stdout.write(SHOW); return;
    }

    const rows = stdout.rows - 5;
    const maxOff = Math.max(0, state.memories.length - rows);
    state.offset = Math.min(maxOff, Math.max(0, state.offset));
    if (state.cursor < state.offset) state.offset = state.cursor;
    if (state.cursor >= state.offset + rows) state.offset = state.cursor - rows + 1;

    const colW = Math.min(80, stdout.columns - 2);
    const tagW = 10;
    const impW = 5;
    const idW = 4;
    const bodyW = colW - idW - impW - tagW - 5;

    const visible = state.memories.slice(state.offset, state.offset + rows);
    for (let i = 0; i < visible.length; i++) {
      const idx = state.offset + i;
      const m = visible[i]!;
      const cur = idx === state.cursor;

      const id = String(m.id).padStart(idW);
      const imp = (m.importance * 100).toFixed(0).padStart(2) + "%";
      const cat = m.category.substring(0, tagW).padEnd(tagW);
      const text = preview(m.content, bodyW).padEnd(bodyW);

      if (cur) stdout.write(REV);
      stdout.write(" " + id + " " + imp + " ");
      stdout.write(catColor(m.category) + cat + RST);
      if (cur) stdout.write(REV);
      stdout.write(" " + text);
      if (cur) stdout.write(RST);
      stdout.write("\n");
    }

    stdout.write(" " + DIM + "─".repeat(colW) + RST + "\n");
    const pct = state.memories.length > 0 ? (state.offset + 1) + "-" + Math.min(state.offset + rows, state.memories.length) + "/" + state.memories.length : "empty";
    stdout.write(" " + DIM + pct + RST + "\n");
    stdout.write(SHOW);
  }

  function renderCreate() {
    stdout.write(" New Memory  " + DIM + "[Tab]next  [Enter]save  [Esc]cancel" + RST + "\n");

    const fields: { key: InputMode; label: string; val: string; multi: boolean }[] = [
      { key: "createContent", label: "Content", val: state.newContent, multi: true },
      { key: "createCategory", label: "Category", val: state.newCategory, multi: false },
      { key: "createImportance", label: "Importance", val: state.newImportance, multi: false },
      { key: "createTags", label: "Tags", val: state.newTags, multi: false },
    ];

    for (const f of fields) {
      const active = mode === f.key;
      if (active) stdout.write(REV);
      stdout.write(" " + f.label + ": ");
      if (f.multi) { stdout.write("\n  "); f.val ? stdout.write(f.val) : stdout.write(DIM + "(required)" + RST + (active ? "" : "")); }
      else { stdout.write(f.val); }
      if (active) stdout.write("█");
      if (active) stdout.write(RST);
      stdout.write("\n");
      if (f.multi) stdout.write("\n");
    }
    stdout.write("\n " + DIM + "Tab to switch, Enter to save, Esc to cancel" + RST + "\n");
    stdout.write(SHOW);
  }

  function renderDetail() {
    const m = state.detailItem!;
    const cols = Math.min(80, stdout.columns - 2);

    stdout.write(BOLD + " Memory #" + m.id + RST);
    stdout.write("  " + DIM + "[Esc]back  [d]delete" + RST + "\n\n");

    // Content box
    const lines = m.content.split("\n").filter(l => !l.startsWith("---"));
    for (const line of lines.slice(0, 50)) {
      stdout.write(" " + line.substring(0, cols - 2) + "\n");
    }
    if (lines.length > 50) stdout.write(" " + DIM + "..." + (lines.length - 50) + " more lines" + RST + "\n");

    stdout.write("\n " + DIM + "─".repeat(cols) + RST + "\n");
    stdout.write(" " + (DIM + "ID:" + RST + " " + m.id + "  "));
    stdout.write(catColor(m.category) + m.category + RST + "  ");
    stdout.write(DIM + "Importance:" + RST + " " + (m.importance * 100).toFixed(0) + "%  ");
    stdout.write(DIM + "Project:" + RST + " " + m.project_id + "\n");
    stdout.write(" " + DIM + "Created:" + RST + " " + (m.created_at || "?") + "\n");
    if (m.tags?.length) stdout.write(" " + DIM + "Tags:" + RST + " " + m.tags.join(", ") + "\n");
    if (m.location) stdout.write(" " + DIM + "Location:" + RST + " " + m.location + "\n");
    stdout.write(SHOW);
  }

  function cleanup() {
    stdin.setRawMode?.(false);
    stdout.write(CLEAR + SHOW);
  }

  load();

  stdin.on("data", (data: Buffer) => {
    buf += data.toString();

    while (buf.length > 0) {
      let key = "";
      let consumed = 0;

      if (buf[0] === ESC) {
        if (buf.startsWith(ESC + "[A")) { key = "UP"; consumed = 3; }
        else if (buf.startsWith(ESC + "[B")) { key = "DOWN"; consumed = 3; }
        else if (buf.startsWith(ESC + "[C")) { key = "RIGHT"; consumed = 3; }
        else if (buf.startsWith(ESC + "[D")) { key = "LEFT"; consumed = 3; }
        else if (buf.startsWith(ESC + "[H")) { key = "HOME"; consumed = 3; }
        else if (buf.startsWith(ESC + "[F")) { key = "END"; consumed = 3; }
        else if (buf.startsWith(ESC + "[5~")) { key = "PAGEUP"; consumed = 3; }
        else if (buf.startsWith(ESC + "[6~")) { key = "PAGEDOWN"; consumed = 3; }
        else if (buf.startsWith(ESC + "[3~")) { key = "DEL"; consumed = 3; }
        else if (buf === ESC) { key = "ESC"; consumed = 1; }
        else { consumed = 1; buf = buf.slice(1); continue; }
      } else if (buf[0] === "\r" || buf[0] === "\n") { key = "ENTER"; consumed = 1; }
      else if (buf[0] === "\x7f" || buf[0] === "\b") { key = "BS"; consumed = 1; }
      else if (buf[0] === "\t") { key = "TAB"; consumed = 1; }
      else if (buf[0] === "\x03") { key = "CTRLC"; consumed = 1; }
      else { key = buf[0]!; consumed = 1; }

      buf = buf.slice(consumed);

      // ── Input mode dispatch ──
      if (mode.startsWith("create")) {
        if (key === "ESC") { mode = "none"; render(); continue; }
        if (key === "TAB") {
          const order: InputMode[] = ["createContent", "createCategory", "createImportance", "createTags"];
          const i = order.indexOf(mode);
          mode = order[(i + 1) % order.length]!;
          render(); continue;
        }
        if (key === "ENTER") {
          if (mode === "createTags") {
            const imp = parseFloat(state.newImportance);
            const r = Memory.store(db, state.newContent, {
              category: state.newCategory || "fact",
              importance: isNaN(imp) ? 0.5 : imp,
              tags: state.newTags.split(",").map(t => t.trim()).filter(Boolean),
            });
            msg(r.ok ? "Stored #" + r.id : "Failed: " + r.reason);
            if (r.ok) load();
            mode = "none"; render(); continue;
          }
          const order: InputMode[] = ["createContent", "createCategory", "createImportance", "createTags"];
          const i = order.indexOf(mode);
          mode = order[(i + 1) % order.length]!;
          render(); continue;
        }
        if (key === "BS") {
          if (mode === "createContent") state.newContent = state.newContent.slice(0, -1);
          else if (mode === "createCategory") state.newCategory = state.newCategory.slice(0, -1);
          else if (mode === "createImportance") state.newImportance = state.newImportance.slice(0, -1);
          else if (mode === "createTags") state.newTags = state.newTags.slice(0, -1);
          render(); continue;
        }
        if (key.length === 1) {
          if (mode === "createContent") state.newContent += key;
          else if (mode === "createCategory") state.newCategory += key;
          else if (mode === "createImportance") state.newImportance += key;
          else if (mode === "createTags") state.newTags += key;
          render(); continue;
        }
        render(); continue;
      }

      if (mode === "search") {
        if (key === "ESC" || key === "CTRLC") { mode = "none"; state.searchQuery = ""; load(); render(); continue; }
        if (key === "ENTER") { mode = "none"; load(); render(); continue; }
        if (key === "BS") { state.searchQuery = state.searchQuery.slice(0, -1); render(); continue; }
        if (key.length === 1) { state.searchQuery += key; render(); continue; }
        render(); continue;
      }

      if (state.screen === "confirm") {
        if (key === "y" && state.confirmAction) { state.confirmAction(); }
        state.screen = "list"; mode = "none"; render(); continue;
      }

      if (state.screen === "detail") {
        if (key === "ESC") { state.screen = "list"; render(); continue; }
        if (key === "d") {
          const m = state.detailItem!;
          if (m) {
            state.confirmMsg = "Delete memory #" + m.id + "?";
            state.confirmAction = () => { Memory.softDelete(db, m.id); load(); msg("Deleted #" + m.id); };
            mode = "confirm";
            state.screen = "confirm";
            render(); continue;
          }
        }
        if (key === "UP" || key === "DOWN") { } // scroll handled via continue
        render(); continue;
      }

      // ── List mode ──
      switch (key) {
        case "q": case "ESC": cleanup(); process.exit(0);
        case "UP": if (state.cursor > 0) state.cursor--; break;
        case "DOWN": if (state.cursor < state.memories.length - 1) state.cursor++; break;
        case "PAGEUP": state.cursor = Math.max(0, state.cursor - 15); break;
        case "PAGEDOWN": state.cursor = Math.min(state.memories.length - 1, state.cursor + 15); break;
        case "HOME": state.cursor = 0; break;
        case "END": state.cursor = state.memories.length - 1; break;
        case "ENTER":
          if (state.memories[state.cursor]) {
            state.detailItem = state.memories[state.cursor]!;
            state.screen = "detail";
          }
          break;
        case "/": mode = "search"; state.searchQuery = ""; break;
        case "n":
          mode = "createContent";
          state.newContent = ""; state.newCategory = "fact"; state.newImportance = "0.5"; state.newTags = "";
          break;
        case "d":
          if (state.memories[state.cursor]) {
            const m = state.memories[state.cursor]!;
            state.confirmMsg = "Delete memory #" + m.id + "?";
            state.confirmAction = () => { Memory.softDelete(db, m.id); load(); msg("Deleted #" + m.id); };
            state.screen = "confirm"; mode = "confirm";
          }
          break;
        case "r": load(); msg("Refreshed"); break;
      }
      render();
    }
  });

  render();
}
