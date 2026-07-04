import * as Memory from "./memory.js";
import React, { useState, useEffect, useRef } from "react";
import { render, Text, Box, useInput, useApp, useStdout } from "ink";
import type { Engram } from "./types.js";

type Light = Omit<Engram, "embedding">;

// --- theme: 完全依赖终端自身配色，不写死 hex 色值 ---
// Ink 支持 ANSI 颜色名（'cyan' / 'green' / 'red' / 'yellow' / 'gray' 等），
// 实际渲染出的具体色值由用户终端的调色板决定，换主题终端也会跟着变。
const THEME = {
    accent: "cyan" as const, // 高亮 / 选中 / 强调
    text: undefined, // 不设置 => 使用终端默认前景色
    dim: "gray" as const, // 次要文字
    danger: "red" as const,
    ok: "green" as const,
    warn: "yellow" as const,
};

// One accent-derived shade per category instead of a rainbow — differ by
// dimness, not hue, so the list reads as calm rather than a stoplight.
function catColor(c: string): string {
    if (c.includes("user") || c.includes("pref")) return THEME.accent;
    if (c.includes("corr")) return THEME.danger;
    if (c.includes("chat") || c.includes("summary")) return THEME.warn;
    if (c.includes("post") || c.includes("blog")) return THEME.ok;
    return THEME.dim;
}

// --- display-width helpers (CJK / fullwidth chars render as 2 columns) ---

function charWidth(code: number): number {
    if (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd)
    )
        return 2;
    return 1;
}

function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += charWidth(ch.codePointAt(0)!);
    return w;
}

function clipToWidth(s: string, maxWidth: number): string {
    let w = 0;
    let out = "";
    for (const ch of s) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (w + cw > maxWidth) break;
        out += ch;
        w += cw;
    }
    return out;
}

function firstLine(s: string, maxWidth = 80): string {
    const lines = s.split("\n");
    // Many memories store YAML frontmatter (a leading "---" fence). The old
    // version took line[0] verbatim, and when line[0] *was* "---" it got
    // replaced with "" and returned as-is — never advancing to the next
    // line. That's why most rows showed a blank preview. Skip fences/blank
    // lines until we hit something with actual content.
    let i = 0;
    while (i < lines.length) {
        const l = lines[i]!.trim();
        if (l === "" || l === "---") {
            i++;
            continue;
        }
        break;
    }
    const l = (lines[i] ?? "").trim().replace(/^title:\s*/i, "");
    return clipToWidth(l, maxWidth);
}

function clipCategory(cat: string, width: number): string {
    if (cat.length <= width) return cat.padEnd(width);
    const boundary = Math.max(
        cat.lastIndexOf("-", width - 1),
        cat.lastIndexOf("_", width - 1),
    );
    if (boundary >= Math.floor(width * 0.5)) {
        return cat.substring(0, boundary).padEnd(width);
    }
    return (cat.substring(0, width - 1) + "…").padEnd(width);
}

function rule(width: number): string {
    return "─".repeat(Math.max(0, width));
}

// Word-wrap a single logical line to `width` display columns, so a memory
// whose body has no internal "\n" (common — many are one long paragraph)
// still shows in full instead of being cut off at the first screen-width.
// Breaks on whitespace where possible; a run with no spaces longer than
// `width` (long CJK spans, URLs) is hard-wrapped by character.
function wrapLine(line: string, width: number): string[] {
    if (line === "") return [""];
    const tokens = line.split(/(\s+)/).filter((t) => t !== "");
    const out: string[] = [];
    let cur = "";
    let curW = 0;

    function push() {
        out.push(cur);
        cur = "";
        curW = 0;
    }

    for (let token of tokens) {
        let tw = displayWidth(token);
        while (tw > width) {
            // token alone doesn't fit even on an empty line — hard-wrap it
            if (curW > 0) {
                push();
            }
            const piece = clipToWidth(token, width);
            out.push(piece);
            token = token.slice(piece.length);
            tw = displayWidth(token);
        }
        if (curW + tw > width) push();
        cur += token;
        curW += tw;
    }
    if (cur !== "" || out.length === 0) push();
    return out;
}

// Wrap a full multi-paragraph memory body into display lines, preserving
// explicit "\n" breaks as paragraph breaks.
function wrapContent(content: string, width: number): string[] {
    return content.split("\n").flatMap((l) => wrapLine(l, width));
}

function strip(e: Engram): Light {
    const { embedding: _, ...r } = e;
    return r;
}

type Screen = "list" | "search" | "detail" | "create" | "confirm";

// Context-sensitive footer hints — one line, changes with `screen`, so we
// never show two different sets of key hints (one global, one embedded in
// the current screen's own component) at the same time.
const FOOTER_HINTS: Record<Screen, [string, string][]> = {
    list: [
        ["↑↓", "nav"],
        ["↵", "open"],
        ["/", "search"],
        ["n", "new"],
        ["d", "delete"],
        ["r", "refresh"],
        ["q", "quit"],
    ],
    search: [
        ["esc", "cancel"],
        ["↵", "apply"],
    ],
    detail: [
        ["↑↓/j/k", "scroll"],
        ["esc", "back"],
        ["d", "delete"],
        ["q", "quit"],
    ],
    create: [
        ["tab", "next"],
        ["↵", "save on tags"],
        ["esc", "cancel"],
    ],
    confirm: [
        ["y", "yes"],
        ["n", "no"],
        ["esc", "cancel"],
    ],
};

function FooterHints({ screen }: { screen: Screen }) {
    const hints = FOOTER_HINTS[screen] ?? FOOTER_HINTS.list;
    return React.createElement(
        Text,
        { color: THEME.dim },
        ...hints.flatMap(([key, label], i) => [
            React.createElement(
                Text,
                { key: `k${i}`, color: THEME.accent },
                key,
            ),
            ` ${label}` + (i < hints.length - 1 ? "  " : ""),
        ]),
    );
}

function SearchInput({ value, width }: { value: string; width: number }) {
    return React.createElement(
        Box,
        { height: 1, paddingX: 1 },
        React.createElement(Text, { color: THEME.accent }, "› "),
        React.createElement(Text, { color: THEME.text }, value || ""),
        React.createElement(Text, { color: THEME.accent, dimColor: true }, "▏"),
    );
}

function CreateForm({
    content,
    cat,
    imp,
    tags,
    focus,
}: {
    content: string;
    cat: string;
    imp: string;
    tags: string;
    focus: number;
}) {
    const fields = [
        { label: "content", val: content },
        { label: "category", val: cat },
        { label: "importance", val: imp },
        { label: "tags", val: tags },
    ];

    return React.createElement(
        Box,
        { flexDirection: "column", paddingX: 1, paddingY: 1 },
        React.createElement(Text, { color: THEME.accent }, "new memory"),
        React.createElement(Box, { height: 1 }),
        ...fields.map((f, i) =>
            React.createElement(
                Box,
                { key: f.label, height: 1 },
                React.createElement(
                    Text,
                    { color: i === focus ? THEME.accent : THEME.dim },
                    i === focus ? "› " : "  ",
                ),
                React.createElement(Text, { color: THEME.dim }, `${f.label}  `),
                React.createElement(
                    Text,
                    { color: THEME.text },
                    f.val || (i === 0 ? "(required)" : ""),
                ),
            ),
        ),
        React.createElement(Box, { height: 1 }),
    );
}

function ConfirmDialog({ msg, width }: { msg: string; width: number }) {
    // width comes in as the raw terminal width; this Box's own paddingX:1
    // costs 2 columns, so the rule must be drawn 2 columns narrower.
    const inner = Math.max(10, width - 2);
    return React.createElement(
        Box,
        { paddingX: 1, paddingY: 1, flexDirection: "column" },
        React.createElement(Text, { color: THEME.dim }, rule(inner)),
        React.createElement(Text, { color: THEME.text }, msg),
    );
}

function DetailView({
    item,
    width,
    contentHeight,
    scroll,
}: {
    item: Light;
    width: number;
    contentHeight: number;
    scroll: number;
}) {
    // paddingX:1 on this Box costs 2 columns total — every child text must
    // wrap/clip to (width - 2), not the raw terminal width, or the trailing
    // characters overflow onto a wrapped second line.
    const inner = Math.max(10, width - 2);
    const wrapped = wrapContent(item.content, inner);
    const visible = wrapped.slice(scroll, scroll + contentHeight);
    const truncatedNote =
        wrapped.length > contentHeight
            ? `line ${scroll + 1}–${Math.min(scroll + contentHeight, wrapped.length)} / ${wrapped.length} `
            : "";

    return React.createElement(
        Box,
        {
            flexDirection: "column",
            paddingX: 1,
            paddingY: 1,
        },
        React.createElement(
            Text,
            { color: THEME.accent },
            `memory #${item.id}`,
        ),
        React.createElement(Text, { dimColor: true }, rule(inner)),
        React.createElement(
            Box,
            { flexDirection: "column", height: contentHeight, marginY: 1 },
            visible.map((l, i) =>
                React.createElement(
                    Text,
                    { key: scroll + i, color: THEME.text },
                    l,
                ),
            ),
        ),
        React.createElement(Text, { dimColor: true }, truncatedNote || " "),
        React.createElement(Text, { dimColor: true }, rule(inner)),
        React.createElement(
            Text,
            null,
            React.createElement(Text, { color: THEME.dim }, "category  "),
            React.createElement(
                Text,
                { color: catColor(item.category) },
                item.category,
            ),
        ),
        React.createElement(
            Text,
            null,
            React.createElement(Text, { color: THEME.dim }, "importance  "),
            React.createElement(
                Text,
                { color: THEME.text },
                `${(item.importance * 100).toFixed(0)}%`,
            ),
        ),
        React.createElement(
            Text,
            null,
            React.createElement(Text, { color: THEME.dim }, "project  "),
            React.createElement(
                Text,
                { color: THEME.text },
                String(item.project_id),
            ),
        ),
        React.createElement(
            Text,
            null,
            React.createElement(Text, { color: THEME.dim }, "created  "),
            React.createElement(
                Text,
                { color: THEME.text },
                item.created_at || "?",
            ),
        ),
        item.tags?.length
            ? React.createElement(
                  Text,
                  null,
                  React.createElement(Text, { color: THEME.dim }, "tags  "),
                  React.createElement(
                      Text,
                      { color: THEME.text },
                      item.tags.join(", "),
                  ),
              )
            : null,
        item.location
            ? React.createElement(
                  Text,
                  null,
                  React.createElement(Text, { color: THEME.dim }, "location  "),
                  React.createElement(
                      Text,
                      { color: THEME.text },
                      item.location,
                  ),
              )
            : null,
    );
}

const TOP_CHROME_ROWS = 2; // title + rule (list mode only)
const BOTTOM_CHROME_ROWS = 2; // rule + FooterHints (always rendered)
const CHROME_ROWS = TOP_CHROME_ROWS + BOTTOM_CHROME_ROWS; // legacy alias for detail view
const SEARCH_ROW = 1;

function App({ db }: { db: ReturnType<typeof Memory.openDb> }) {
    const [items, setItems] = useState<Light[]>([]);
    const [idx, setIdx] = useState(0);
    const [screen, setScreen] = useState<Screen>("list");
    const [detail, setDetail] = useState<Light | null>(null);
    const [detailScroll, setDetailScroll] = useState(0);

    const [sq, setSq] = useState("");
    const [cc, setCc] = useState("");
    const [cCat, setCCat] = useState("fact");
    const [cImp, setCImp] = useState("0.5");
    const [cTags, setCTags] = useState("");
    const [cFocus, setCFocus] = useState(0);
    const [confirmMsg, setConfirmMsg] = useState("");
    const [confirmCb, setConfirmCb] = useState<(() => void) | null>(null);
    const [prevScreen, setPrevScreen] = useState<Screen>("list");

    const [status, setStatus] = useState("");
    const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    function msg(s: string) {
        setStatus(s);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(""), 2000);
    }

    function load(q?: string) {
        const r = q
            ? Memory.search(db, q, { limit: 200, min_similarity: 0 })
            : Memory.list(db, { limit: 500 });
        setItems(r.map(strip));
        setIdx(0);
    }

    useEffect(() => {
        load();
    }, []);

    useEffect(() => {
        if (screen !== "search") return;
        const t = setTimeout(() => load(sq), 150);
        return () => clearTimeout(t);
    }, [sq, screen]);

    function askDelete(item: Light, from: Screen) {
        setPrevScreen(from);
        setConfirmMsg(
            `delete memory #${item.id}: ${firstLine(item.content, 40)}?`,
        );
        setConfirmCb(() => () => {
            Memory.softDelete(db, item.id!);
            load();
            msg(`deleted #${item.id}`);
        });
        setScreen("confirm");
    }

    const { stdout } = useStdout();
    const termRows = stdout?.rows ?? 24;
    const termCols = stdout?.columns ?? 100;
    const showHeader = screen === "list";
    const chromeRows =
        (showHeader ? TOP_CHROME_ROWS : 0) +
        (screen === "search" ? SEARCH_ROW : 0) +
        BOTTOM_CHROME_ROWS;
    const visibleRows = Math.max(3, termRows - chromeRows - 1);

    const [scrollTop, setScrollTop] = useState(0);
    useEffect(() => {
        if (idx < scrollTop) setScrollTop(idx);
        else if (idx >= scrollTop + visibleRows)
            setScrollTop(idx - visibleRows + 1);
        const maxTop = Math.max(0, items.length - visibleRows);
        if (scrollTop > maxTop) setScrollTop(maxTop);
    }, [idx, visibleRows, items.length]);

    const visibleItems = items.slice(scrollTop, scrollTop + visibleRows);

    // Detail-view content viewport: reserve rows for the fixed chrome around
    // the content box (title, two rules, 4 metadata lines, optional tags/
    // location, margin, footer hint, the view's own paddingY, plus the app's
    // own top/bottom chrome) so long memory bodies scroll instead of overflow.
    const detailInner = Math.max(10, termCols - 2);
    const detailWrapped = detail
        ? wrapContent(detail.content, detailInner)
        : [];
    const detailFixedRows =
        12 +
        (detail?.tags?.length ? 1 : 0) +
        (detail?.location ? 1 : 0) +
        CHROME_ROWS;
    const detailContentHeight = Math.max(3, termRows - detailFixedRows);

    useEffect(() => {
        const maxTop = Math.max(0, detailWrapped.length - detailContentHeight);
        if (detailScroll > maxTop) setDetailScroll(maxTop);
    }, [detail, detailContentHeight, detailWrapped.length]);

    useInput((input, key) => {
        switch (screen) {
            case "detail":
                if (input === "q") {
                    process.exit(0);
                    return;
                }
                if (key.escape) {
                    setScreen("list");
                    setDetail(null);
                    return;
                }
                if (input === "d" && detail) askDelete(detail, "detail");
                if (key.upArrow || input === "k") {
                    setDetailScroll((s) => Math.max(0, s - 1));
                    return;
                }
                if (key.downArrow || input === "j") {
                    setDetailScroll((s) =>
                        Math.min(
                            Math.max(
                                0,
                                detailWrapped.length - detailContentHeight,
                            ),
                            s + 1,
                        ),
                    );
                    return;
                }
                if (input === "pageup") {
                    setDetailScroll((s) =>
                        Math.max(0, s - detailContentHeight),
                    );
                    return;
                }
                if (input === "pagedown") {
                    setDetailScroll((s) =>
                        Math.min(
                            Math.max(
                                0,
                                detailWrapped.length - detailContentHeight,
                            ),
                            s + detailContentHeight,
                        ),
                    );
                    return;
                }
                return;

            case "confirm":
                if (input === "q") {
                    process.exit(0);
                    return;
                }
                if (input === "y" && confirmCb) {
                    confirmCb();
                    setScreen("list");
                    setDetail(null);
                } else if (input === "n" || key.escape) {
                    setScreen(prevScreen);
                }
                return;

            case "search":
                if (key.escape) {
                    setScreen("list");
                    setSq("");
                    load();
                    return;
                }
                if (key.return) {
                    setScreen("list");
                    load(sq);
                    return;
                }
                if (key.backspace || key.delete) {
                    setSq((s) => s.slice(0, -1));
                    return;
                }
                if (input && input.length === 1) setSq((s) => s + input);
                return;

            case "create":
                if (key.escape) {
                    setScreen("list");
                    return;
                }
                if (key.tab) {
                    setCFocus((f) => (f + 1) % 4);
                    return;
                }
                if (key.return) {
                    if (cFocus === 3) {
                        const imp = parseFloat(cImp);
                        Memory.store(db, cc, {
                            category: cCat || "fact",
                            importance: isNaN(imp) ? 0.5 : imp,
                            tags: cTags
                                .split(",")
                                .map((t) => t.trim())
                                .filter(Boolean),
                        });
                        load();
                        setScreen("list");
                        msg("memory created");
                        return;
                    }
                    setCFocus((f) => (f + 1) % 4);
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

        if (input === "q") process.exit(0);
        if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
        if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1));
        if (input === "pageup") setIdx((i) => Math.max(0, i - visibleRows));
        if (input === "pagedown")
            setIdx((i) => Math.min(items.length - 1, i + visibleRows));
        if (key.return && items[idx]) {
            setDetail(items[idx]!);
            setDetailScroll(0);
            setScreen("detail");
        }
        if (input === "/") {
            setScreen("search");
            setSq("");
        }
        if (input === "n") {
            setCc("");
            setCCat("fact");
            setCImp("0.5");
            setCTags("");
            setCFocus(0);
            setScreen("create");
        }
        if (input === "d" && items[idx]) askDelete(items[idx]!, "list");
        if (input === "r") {
            load();
            msg("refreshed");
        }
    });

    return React.createElement(
        Box,
        { flexDirection: "column", height: "100%" },
        ...(showHeader
            ? [
                  // Title — plain text, no colored block
                  React.createElement(
                      Box,
                      { height: 1, paddingX: 1 },
                      React.createElement(Text, { color: THEME.accent }, "◆ "),
                      React.createElement(
                          Text,
                          { bold: true, color: THEME.text },
                          "openmemory",
                      ),
                      React.createElement(Box, { flexGrow: 1 }),
                      React.createElement(
                          Text,
                          { color: THEME.dim },
                          items.length > visibleRows
                              ? `${scrollTop + 1}–${Math.min(scrollTop + visibleRows, items.length)} / ${items.length}`
                              : `${items.length} memories`,
                      ),
                  ),
                  React.createElement(
                      Box,
                      { height: 1, paddingX: 1 },
                      React.createElement(
                          Text,
                          { dimColor: true },
                          rule(termCols - 2),
                      ),
                  ),
              ]
            : []),

        screen === "search"
            ? React.createElement(SearchInput, { value: sq, width: termCols })
            : null,

        screen === "detail" && detail
            ? React.createElement(DetailView, {
                  item: detail,
                  width: termCols,
                  contentHeight: detailContentHeight,
                  scroll: detailScroll,
              })
            : null,

        screen === "confirm"
            ? React.createElement(ConfirmDialog, {
                  msg: confirmMsg,
                  width: termCols,
              })
            : null,

        screen === "create"
            ? React.createElement(CreateForm, {
                  content: cc,
                  cat: cCat,
                  imp: cImp,
                  tags: cTags,
                  focus: cFocus,
              })
            : null,

        screen === "list" || screen === "search"
            ? React.createElement(
                  Box,
                  { flexDirection: "column", height: visibleRows, paddingX: 1 },
                  items.length === 0
                      ? React.createElement(
                            Box,
                            { paddingY: 1 },
                            React.createElement(
                                Text,
                                { color: THEME.dim },
                                "no memories found",
                            ),
                        )
                      : visibleItems.map((item) => {
                            const active = item === items[idx];
                            const pct = (item.importance * 100).toFixed(0);
                            const catCol = clipCategory(item.category, 12);
                            const contentWidth = Math.max(10, termCols - 28);
                            return React.createElement(
                                Box,
                                { key: item.id, height: 1 },
                                React.createElement(
                                    Text,
                                    {
                                        color: active
                                            ? THEME.accent
                                            : undefined,
                                        dimColor: !active,
                                    },
                                    active ? "› " : "  ",
                                ),
                                React.createElement(
                                    Text,
                                    { color: THEME.dim },
                                    String(item.id).padStart(4),
                                ),
                                React.createElement(Text, null, " "),
                                React.createElement(
                                    Text,
                                    {
                                        dimColor: item.importance < 0.9,
                                        bold: item.importance >= 0.9,
                                    },
                                    pct.padStart(3) + "%",
                                ),
                                React.createElement(Text, null, " "),
                                React.createElement(
                                    Text,
                                    { color: catColor(item.category) },
                                    catCol,
                                ),
                                React.createElement(
                                    Text,
                                    {
                                        color: active ? THEME.text : undefined,
                                        dimColor: !active,
                                        wrap: "truncate",
                                    },
                                    `  ${firstLine(item.content, contentWidth)}`,
                                ),
                            );
                        }),
              )
            : null,

        // Footer — thin rule + muted hints, accent only on the keys themselves
        React.createElement(
            Box,
            { height: 1, paddingX: 1 },
            React.createElement(Text, { dimColor: true }, rule(termCols - 2)),
        ),
        React.createElement(
            Box,
            { height: 1, paddingX: 1 },
            status
                ? React.createElement(Text, { color: THEME.ok }, status)
                : React.createElement(FooterHints, { screen }),
        ),
    );
}

export function startTui(db: ReturnType<typeof Memory.openDb>): void {
    const { waitUntilExit } = render(React.createElement(App, { db }));
    waitUntilExit();
}

if (import.meta.main) {
    const p = process.env.OPENMEMORY_DB_PATH;
    if (!p) {
        process.stderr.write("OPENMEMORY_DB_PATH not set\n");
        process.exit(1);
    }
    startTui(Memory.openDb(p));
}
