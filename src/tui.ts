import type { Database } from "bun:sqlite";
import * as Memory from "./memory.js";

const ESC = "\x1b";
const CSI = ESC + "[";
const CLEAR = CSI + "2J" + CSI + "H";
const HIDE = CSI + "?25l";
const SHOW = CSI + "?25h";
const REV = CSI + "7m";
const RST = CSI + "0m";
const BOLD = CSI + "1m";
const DIM = CSI + "2m";
const HOME = CSI + "H";

type EngramLight = Omit<Memory.Engram, "embedding">;
type Screen = "list" | "search" | "create" | "detail" | "confirm";

interface State {
  screen: Screen;
  memories: EngramLight[];
  cursor: number;
  offset: number;
  searchQuery: string;
  createContent: string;
  createCategory: string;
  createImportance: string;
  createTags: string;
  detailItem: EngramLight | null;
  confirmMsg: string;
  confirmAction: (() => void) | null;
  statusMsg: string;
  statusTime: number;
}

export function startTui(db: Database): void {
  const state: State = {
    screen: "list",
    memories: [],
    cursor: 0,
    offset: 0,
    searchQuery: "",
    createContent: "",
    createCategory: "fact",
    createImportance: "0.5",
    createTags: "",
    detailItem: null,
    confirmMsg: "",
    confirmAction: null,
    statusMsg: "",
    statusTime: 0,
  };

  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    process.stderr.write("TTY required for TUI mode\n");
    process.exit(1);
  }

  stdin.setRawMode?.(true);
  stdin.resume();

  let buf = "";
  let inputMode: "none" | "search" | "create" | "confirm" = "none";
  let createField: "content" | "category" | "importance" | "tags" = "content";

  function render() {
    stdout.write(CLEAR);
    stdout.write(HIDE);

    // Header
    stdout.write(BOLD + " OpenMemory TUI" + RST + "  ");
    stdout.write(DIM + "[↑↓]nav [Enter]view [n]new [/]search [d]delete [q]quit" + RST + "\n\n");

    if (state.statusMsg && Date.now() - state.statusTime < 3000) {
      stdout.write(" " + state.statusMsg + "\n\n");
    }

    if (inputMode === "search") {
      stdout.write(" Search: " + state.searchQuery + "█\n\n");
    } else if (inputMode === "create") {
      renderCreateForm(stdout, state, createField);
      return;
    }

    if (state.screen === "detail" && state.detailItem) {
      renderDetail(stdout, state.detailItem);
      return;
    }

    if (state.screen === "confirm") {
      stdout.write(" " + state.confirmMsg + " (y/n) █\n\n");
      return;
    }

    // List
    if (state.memories.length === 0) {
      stdout.write(" No memories found.\n\n");
      stdout.write(" [n] New memory  [/] Search\n");
      return;
    }

    const h = process.stdout.rows - 8;
    const maxOffset = Math.max(0, state.memories.length - h);
    if (state.offset > maxOffset) state.offset = maxOffset;
    if (state.cursor < state.offset) state.offset = state.cursor;
    if (state.cursor >= state.offset + h) state.offset = state.cursor - h + 1;

    const visible = state.memories.slice(state.offset, state.offset + h);
    for (let i = 0; i < visible.length; i++) {
      const idx = state.offset + i;
      const isCur = idx === state.cursor;
      const m = visible[i]!;

      if (isCur) stdout.write(REV);
      const content = m.content.replace(/\n/g, " ").substring(0, process.stdout.columns - 20);
      const imp = (m.importance * 100).toFixed(0);
      const cat = m.category.substring(0, 12);
      stdout.write(` ${String(m.id).padStart(4)} ${imp.padStart(3)}% ${cat.padEnd(12)} ${content}`);
      if (isCur) stdout.write(RST);
      stdout.write("\n");
    }

    stdout.write("\n " + DIM + `${state.offset + 1}-${Math.min(state.offset + h, state.memories.length)} of ${state.memories.length}` + RST + "\n");
    stdout.write(SHOW);
  }

  function loadMemories() {
    const opts: Memory.ListOptions = { limit: 200 };
    if (state.searchQuery) {
      state.memories = Memory.search(db, state.searchQuery, { limit: 200, min_similarity: 0 }).map(strip);
    } else {
      state.memories = Memory.list(db, opts).map(strip);
    }
    state.cursor = 0;
    state.offset = 0;
  }

  function strip(e: Memory.Engram): EngramLight {
    const { embedding: _, ...rest } = e;
    return rest;
  }

  function setStatus(msg: string) {
    state.statusMsg = msg;
    state.statusTime = Date.now();
  }

  const handlers: Record<string, (key: string) => void> = {
    "none": (key) => {
      switch (key) {
        case "q": case ESC: cleanup(); process.exit(0); break;
        case "UP": if (state.cursor > 0) state.cursor--; break;
        case "DOWN": if (state.cursor < state.memories.length - 1) state.cursor++; break;
        case "PAGEUP": state.cursor = Math.max(0, state.cursor - process.stdout.rows + 8); break;
        case "PAGEDOWN": state.cursor = Math.min(state.memories.length - 1, state.cursor + process.stdout.rows - 8); break;
        case "HOME": state.cursor = 0; break;
        case "END": state.cursor = state.memories.length - 1; break;
        case "ENTER":
          if (state.memories[state.cursor]) {
            state.detailItem = state.memories[state.cursor]!;
            state.screen = "detail";
          }
          break;
        case "/":
          inputMode = "search";
          state.searchQuery = "";
          break;
        case "n":
          inputMode = "create";
          createField = "content";
          state.createContent = "";
          state.createCategory = "fact";
          state.createImportance = "0.5";
          state.createTags = "";
          break;
        case "d":
          if (state.memories[state.cursor]) {
            const m = state.memories[state.cursor]!;
            state.confirmMsg = `Delete memory #${m.id}? "${m.content.substring(0, 60)}"`;
            state.confirmAction = () => {
              Memory.softDelete(db, m.id);
              loadMemories();
              setStatus(`Deleted #${m.id}`);
            };
            state.screen = "confirm";
          }
          break;
        case "r":
          loadMemories();
          setStatus("Refreshed");
          break;
      }
    },
    "search": (key) => {
      if (key === ESC || key === "CTRL_C") { inputMode = "none"; state.searchQuery = ""; loadMemories(); return; }
      if (key === "ENTER") { inputMode = "none"; loadMemories(); return; }
      if (key === "BACKSPACE") { state.searchQuery = state.searchQuery.slice(0, -1); return; }
      if (key.length === 1) { state.searchQuery += key; }
    },
    "confirm": (key) => {
      if (key === "y" && state.confirmAction) {
        state.confirmAction();
        state.screen = "list";
        inputMode = "none";
      } else {
        state.screen = "list";
        inputMode = "none";
      }
    },
    "create": (key) => {
      if (key === ESC) { inputMode = "none"; return; }
      if (key === "TAB") {
        const fields: typeof createField[] = ["content", "category", "importance", "tags"];
        createField = fields[(fields.indexOf(createField) + 1) % fields.length]!;
        return;
      }
      if (key === "ENTER" && createField === "tags") {
        const importance = parseFloat(state.createImportance);
        const result = Memory.store(db, state.createContent, {
          category: state.createCategory || "fact",
          importance: isNaN(importance) ? 0.5 : importance,
          tags: state.createTags.split(",").map((t: string) => t.trim()).filter(Boolean),
        });
        if (result.ok) {
          setStatus(`Stored memory #${result.id}`);
          loadMemories();
        } else {
          setStatus("Failed: " + result.reason);
        }
        inputMode = "none";
        return;
      }
      if (key === "ENTER" && createField !== "tags") {
        const fields: typeof createField[] = ["content", "category", "importance", "tags"];
        createField = fields[(fields.indexOf(createField) + 1) % fields.length]!;
        return;
      }
      if (key === "BACKSPACE") {
        if (createField === "content") state.createContent = state.createContent.slice(0, -1);
        if (createField === "category") state.createCategory = state.createCategory.slice(0, -1);
        if (createField === "importance") state.createImportance = state.createImportance.slice(0, -1);
        if (createField === "tags") state.createTags = state.createTags.slice(0, -1);
        return;
      }
      if (key.length === 1) {
        if (createField === "content") state.createContent += key;
        if (createField === "category") state.createCategory += key;
        if (createField === "importance") state.createImportance += key;
        if (createField === "tags") state.createTags += key;
      }
    },
  };

  function renderCreateForm(stdout: typeof process.stdout, state: State, field: typeof createField) {
    const fields = [
      { key: "content" as const, label: "Content", value: state.createContent },
      { key: "category" as const, label: "Category", value: state.createCategory },
      { key: "importance" as const, label: "Importance", value: state.createImportance },
      { key: "tags" as const, label: "Tags", value: state.createTags },
    ];

    stdout.write(" Create Memory  [Tab]next [Enter]save [Esc]cancel\n\n");
    for (const f of fields) {
      const active = f.key === field;
      if (active) stdout.write(REV);
      stdout.write(` ${f.label}: `);
      if (f.key === "content") {
        stdout.write("\n  " + (f.value || "(required)"));
        if (active) stdout.write("█");
      } else {
        stdout.write(f.value + (active ? "█" : ""));
      }
      if (active) stdout.write(RST);
      stdout.write("\n");
      if (f.key === "content") stdout.write("\n");
    }
    stdout.write("\n " + DIM + "Tab to switch fields, Enter to save, Esc to cancel" + RST + "\n");
    stdout.write(SHOW);
  }

  function renderDetail(stdout: typeof process.stdout, m: EngramLight) {
    const cols = process.stdout.columns;
    stdout.write(` Memory #${m.id}\n\n`);
    stdout.write(DIM + " Content:" + RST + "\n");
    for (const line of m.content.split("\n")) {
      stdout.write("  " + line.substring(0, cols - 4) + "\n");
    }
    stdout.write("\n");
    stdout.write(DIM + " Category:" + RST + " " + m.category + "\n");
    stdout.write(DIM + " Importance:" + RST + " " + (m.importance * 100).toFixed(0) + "%\n");
    stdout.write(DIM + " Project:" + RST + " " + m.project_id + "\n");
    stdout.write(DIM + " Created:" + RST + " " + (m.created_at || "?") + "\n");
    if (m.tags?.length) stdout.write(DIM + " Tags:" + RST + " " + m.tags.join(", ") + "\n");
    if (m.location) stdout.write(DIM + " Location:" + RST + " " + m.location + "\n");
    stdout.write("\n " + DIM + "[Esc]back [d]delete" + RST + "\n");
    stdout.write("\n " + (m.original ? DIM + "Original:" + RST + "\n" + m.original.substring(0, 500) : "") + "\n");
    stdout.write(SHOW);
  }

  function cleanup() {
    stdin.setRawMode?.(false);
    stdout.write(CLEAR);
    stdout.write(SHOW);
  }

  loadMemories();

  stdin.on("data", (data: Buffer) => {
    buf += data.toString();

    // Process complete escape sequences
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
        else if (buf.startsWith(ESC + "[3~")) { key = "DELETE"; consumed = 3; }
        else if (buf === ESC) { key = "ESC"; consumed = 1; }
        else { consumed = 1; buf = buf.slice(1); continue; }
      } else if (buf[0] === "\r" || buf[0] === "\n") {
        key = "ENTER"; consumed = 1;
      } else if (buf[0] === "\x7f" || buf[0] === "\b") {
        key = "BACKSPACE"; consumed = 1;
      } else if (buf[0] === "\t") {
        key = "TAB"; consumed = 1;
      } else if (buf[0] === "\x03") {
        key = "CTRL_C"; consumed = 1;
      } else {
        key = buf[0]!; consumed = 1;
      }

      buf = buf.slice(consumed);
      const handler = handlers[inputMode || "none"];
      if (handler) handler(key);
      render();
    }
  });

  render();
}
