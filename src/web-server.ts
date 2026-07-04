import type { Database } from "bun:sqlite";
import * as Memory from "./memory.js";

export function startWebServer(db: Database, port: number = 3030): void {
  const html = renderHtml();

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

      // API routes
      if (url.pathname === "/api/memory" && method === "GET") {
        const query = url.searchParams.get("q") || "";
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const category = url.searchParams.get("category") || "";

        if (query) {
          const results = Memory.search(db, query, { limit, min_similarity: 0 });
          return json({ kind: "search", query, count: results.length, results });
        }

        const opts: Memory.ListOptions = { limit, offset };
        if (category) opts.category = category;
        const results = Memory.list(db, opts);
        return json({ kind: "list", count: results.length, results });
      }

      if (url.pathname === "/api/memory" && method === "POST") {
        const body = await req.json() as Record<string, unknown>;
        const content = String(body.content || "").trim();
        if (!content) return json({ error: "content is required" }, 400);

        const result = Memory.store(db, content, {
          category: String(body.category || "fact"),
          importance: Number(body.importance ?? 0.5),
          project_id: String(body.project_id || "global"),
          tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
          metadata: typeof body.metadata === "object" && body.metadata ? body.metadata as Record<string, unknown> : undefined,
        });

        if (!result.ok) {
          if (result.reason === "duplicate") return json({ error: "duplicate", id: findExistingId(db, content) }, 409);
          return json({ error: result.reason }, 400);
        }
        return json({ id: result.id }, 201);
      }

      const idMatch = url.pathname.match(/^\/api\/memory\/(\d+)$/);
      if (idMatch) {
        const id = parseInt(idMatch[1]!, 10);

        if (method === "GET") {
          const engram = Memory.get(db, id);
          if (!engram) return json({ error: "not found" }, 404);
          return json({ engram });
        }

        if (method === "DELETE") {
          const result = Memory.softDelete(db, id);
          if (!result.ok) return json({ error: "not found" }, 404);
          return json({ deleted: true });
        }
      }

      if (url.pathname === "/api/stats" && method === "GET") {
        return json({ stats: Memory.stats(db) });
      }

      // Serve the HTML for any other path
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  process.stderr.write(`\n  OpenMemory Web UI: http://localhost:${port}\n\n`);
}

function findExistingId(db: Database, content: string): number | null {
  const row = db.prepare("SELECT id FROM engrams WHERE content = ? LIMIT 1").get(content) as { id: number } | null;
  return row?.id ?? null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenMemory</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz@14..32&display=swap" rel="stylesheet">
<style>
  * { font-family: 'Inter', system-ui, sans-serif; }
  body { background: #0a0a0b; color: #e4e4e7; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; }
  .card-hover:hover { border-color: #3b3b3e; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #27272a; color: #a1a1aa; }
  .input { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 12px; color: #e4e4e7; outline: none; }
  .input:focus { border-color: #6366f1; }
  .btn { padding: 8px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; border: none; transition: all .15s; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-ghost { background: transparent; color: #a1a1aa; border: 1px solid #27272a; }
  .btn-ghost:hover { background: #27272a; color: #e4e4e7; }
  .btn-danger { background: transparent; color: #ef4444; border: 1px solid #27272a; }
  .btn-danger:hover { background: #ef4444; color: #fff; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 6px; background: #1e1e21; color: #818cf8; border: 1px solid #27272a; margin: 2px; }
  .fade-in { animation: fadeIn .2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3b3b3e; border-radius: 3px; }
</style>
</head>
<body class="p-4 md:p-8 max-w-5xl mx-auto">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">OpenMemory</h1>
      <p class="text-sm text-zinc-500 mt-1" id="statsLine">Loading...</p>
    </div>
    <button onclick="showStoreModal()" class="btn btn-primary">+ New Memory</button>
  </div>

  <div class="flex gap-3 mb-6">
    <input id="searchInput" class="input flex-1" placeholder="Search memories..." oninput="debouncedSearch()">
    <button onclick="search()" class="btn btn-ghost">Search</button>
    <button onclick="loadMemories()" class="btn btn-ghost">Clear</button>
  </div>

  <div id="filters" class="flex gap-2 flex-wrap mb-4 text-sm"></div>

  <div id="list" class="space-y-3"></div>

  <div id="storeModal" class="modal-overlay hidden fade-in" onclick="if(event.target===this)hideStoreModal()">
    <div class="card p-6 w-full max-w-lg mx-4" onclick="event.stopPropagation()">
      <h2 class="text-lg font-medium mb-4">New Memory</h2>
      <textarea id="newContent" class="input w-full min-h-[100px] mb-3" placeholder="Content..."></textarea>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div><label class="text-xs text-zinc-500 block mb-1">Category</label><input id="newCategory" class="input w-full" value="fact"></div>
        <div><label class="text-xs text-zinc-500 block mb-1">Importance (0-1)</label><input id="newImportance" class="input w-full" value="0.5" type="number" step="0.1" min="0" max="1"></div>
      </div>
      <div class="mb-3"><label class="text-xs text-zinc-500 block mb-1">Tags (comma separated)</label><input id="newTags" class="input w-full" placeholder="tag1, tag2"></div>
      <div class="flex gap-2 justify-end">
        <button onclick="hideStoreModal()" class="btn btn-ghost">Cancel</button>
        <button onclick="storeMemory()" class="btn btn-primary">Save</button>
      </div>
    </div>
  </div>

  <div id="detailModal" class="modal-overlay hidden fade-in" onclick="if(event.target===this)hideDetailModal()">
    <div class="card p-6 w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto" onclick="event.stopPropagation()">
      <div id="detailContent"></div>
    </div>
  </div>

<script>
let memories = [];

function $(id) { return document.getElementById(id); }
function escapeHtml(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function api(path, opts={}) {
  const r = await fetch(path, { headers: {'Content-Type':'application/json'}, ...opts });
  if (r.status===204) return null;
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

async function loadStats() {
  try {
    const d = await api('/api/stats');
    const s = d.stats;
    const cats = Object.entries(s.by_category).map(([k,v]) => k+'='+v).join(', ');
    $('statsLine').textContent = s.active_engrams + ' active / ' + s.total_engrams + ' total  |  ' + cats;
  } catch {}
}

async function loadMemories() {
  $('searchInput').value = '';
  const d = await api('/api/memory?limit=100');
  memories = d.results;
  renderMemories(d.results);
  renderFilters(d.results);
}

async function search() {
  const q = $('searchInput').value.trim();
  if (!q) return loadMemories();
  const d = await api('/api/memory?q=' + encodeURIComponent(q) + '&limit=50');
  memories = d.results;
  renderMemories(d.results);
  $('filters').innerHTML = '';
}

let debounceTimer;
function debouncedSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(search, 300);
}

function renderMemories(list) {
  const el = $('list');
  if (list.length === 0) { el.innerHTML = '<div class="text-center text-zinc-600 py-12">No memories found</div>'; return; }
  el.innerHTML = list.map(m => \`
    <div class="card card-hover p-4 cursor-pointer fade-in" onclick="showDetail(\${m.id})">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="text-sm line-clamp-3 whitespace-pre-wrap break-words">\${escapeHtml(m.content)}</div>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            <span class="badge">\${escapeHtml(m.category)}</span>
            <span class="badge">\${(m.importance * 100).toFixed(0)}%</span>
            <span class="text-xs text-zinc-600">#\${m.id}</span>
            \${m.tags && m.tags.length ? m.tags.map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('') : ''}
          </div>
          <div class="text-xs text-zinc-600 mt-1">\${m.created_at || ''}</div>
        </div>
        <button onclick="event.stopPropagation();deleteMemory(\${m.id})" class="btn btn-danger text-xs px-2 py-1 shrink-0">Delete</button>
      </div>
    </div>
  \`).join('');
}

function renderFilters(list) {
  const cats = [...new Set(list.map(m => m.category))];
  $('filters').innerHTML = cats.map(c => '<button onclick="filterByCategory(\'' + c + '\')" class="badge cursor-pointer hover:bg-zinc-600">' + escapeHtml(c) + '</button>').join('');
}

async function filterByCategory(cat) {
  const d = await api('/api/memory?limit=100&category=' + encodeURIComponent(cat));
  memories = d.results;
  renderMemories(d.results);
}

async function showDetail(id) {
  const d = await api('/api/memory/' + id);
  const m = d.engram;
  $('detailContent').innerHTML = \`
    <div class="flex items-start justify-between mb-4">
      <h2 class="text-lg font-medium">Memory #\${m.id}</h2>
      <button onclick="hideDetailModal();deleteMemory(\${m.id})" class="btn btn-danger text-xs">Delete</button>
    </div>
    <div class="text-sm whitespace-pre-wrap break-words mb-4 p-3 rounded-lg" style="background:#1a1a1d">\${escapeHtml(m.content)}</div>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div><span class="text-zinc-500">Category</span><br>\${escapeHtml(m.category)}</div>
      <div><span class="text-zinc-500">Importance</span><br>\${(m.importance * 100).toFixed(0)}%</div>
      <div><span class="text-zinc-500">Project</span><br>\${escapeHtml(m.project_id)}</div>
      <div><span class="text-zinc-500">Created</span><br>\${m.created_at || '?'}</div>
      \${m.tags && m.tags.length ? '<div class="col-span-2"><span class="text-zinc-500">Tags</span><br>' + m.tags.map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('') + '</div>' : ''}
      \${m.location ? '<div class="col-span-2"><span class="text-zinc-500">Location</span><br>' + escapeHtml(m.location) + '</div>' : ''}
      \${m.original ? '<div class="col-span-2"><span class="text-zinc-500">Original</span><br><div class="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto mt-1 p-2 rounded" style="background:#1a1a1d">' + escapeHtml(m.original) + '</div></div>' : ''}
    </div>
    \${m.metadata && Object.keys(m.metadata).length ? '<div class="mt-4"><span class="text-zinc-500 text-sm">Metadata</span><pre class="text-xs mt-1 p-2 rounded overflow-x-auto" style="background:#1a1a1d">' + escapeHtml(JSON.stringify(m.metadata, null, 2)) + '</pre></div>' : ''}
  \`;
  $('detailModal').classList.remove('hidden');
}

function hideDetailModal() { $('detailModal').classList.add('hidden'); }

function showStoreModal() { $('storeModal').classList.remove('hidden'); $('newContent').focus(); }
function hideStoreModal() { $('storeModal').classList.add('hidden'); }

async function storeMemory() {
  const content = $('newContent').value.trim();
  if (!content) return;
  const body = {
    content,
    category: $('newCategory').value.trim() || 'fact',
    importance: parseFloat($('newImportance').value) || 0.5,
    tags: $('newTags').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  await api('/api/memory', { method: 'POST', body: JSON.stringify(body) });
  $('newContent').value = '';
  $('newTags').value = '';
  hideStoreModal();
  loadMemories();
  loadStats();
}

async function deleteMemory(id) {
  if (!confirm('Delete memory #' + id + '?')) return;
  await api('/api/memory/' + id, { method: 'DELETE' });
  loadMemories();
  loadStats();
}

loadStats();
loadMemories();
</script>
</body>
</html>`;
}
