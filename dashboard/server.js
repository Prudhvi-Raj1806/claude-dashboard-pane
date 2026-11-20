#!/usr/bin/env node
// Claude Dashboard — read-only local view of Claude transcripts in ~/.claude/projects.
// Run:  node server.js   then open http://127.0.0.1:4317
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const CACHE_FILE = path.join(os.homedir(), '.claude', 'dashboard-cache.json');
const CACHE_VERSION = 1;
const ACTIVE_MS = 5 * 60 * 1000;             // transcript written in last 5 min => active
const ATTENTION_MS = 3 * 24 * 3600 * 1000;   // ignore unanswered prompts older than 3 days
const RESCAN_MS = 15 * 1000;

const index = new Map();                      // transcript path -> summary
const scan = { running: false, complete: false, done: 0, total: 0, lastScan: null };

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const clean = (t, n = 120) => {
  const s = String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? (s.length > n ? s.slice(0, n) + '…' : s) : null;
};
const emptyCounts = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addCounts = (a, b) => { for (const k of Object.keys(emptyCounts())) a[k] += b[k] || 0; return a; };
const bucket = (s, day) => (s.daily[day] ||= { ...emptyCounts(), tools: {}, models: {} });
const projectLabel = (cwd) => {
  if (!cwd) return 'Unknown';
  if (/scratch-workspaces/i.test(cwd)) return 'No folder (scratch)';
  return path.basename(cwd) || cwd;
};

function listJsonl(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---------- transcript summariser (single streaming pass per file) ----------
async function summarize(file, st) {
  const rel = path.relative(PROJECTS_DIR, file);
  const s = {
    sessionId: path.basename(file, '.jsonl'),
    isSubagent: rel.split(path.sep).length > 2,
    mtime: st.mtimeMs, size: st.size,
    cwd: null, entrypoint: null, permissionMode: null, model: null,
    customTitle: null, aiTitle: null, firstPrompt: null, lastUserPrompt: null, lastPrompt: null,
    startTs: null, endTs: null, startDay: null,
    userTurns: 0, assistantTurns: 0, costUSD: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    daily: {}, pendingTools: [], lastError: false,
  };
  const pending = new Map();   // tool_use id -> {name, ts}; removed when a tool_result arrives
  const seenMsg = new Set();   // assistant message ids (records are split per content block)
  const seenTool = new Set();

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { if (!s.startTs) s.startTs = o.timestamp; s.endTs = o.timestamp; }
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.entrypoint && !s.entrypoint) s.entrypoint = o.entrypoint;

    switch (o.type) {
      case 'custom-title': s.customTitle = o.customTitle || s.customTitle; break;
      case 'ai-title': s.aiTitle = o.aiTitle || s.aiTitle; break;
      case 'last-prompt': s.lastPrompt = clean(o.lastPrompt, 140); break;
      case 'cost-state': s.costUSD = Number(o.totalCostUSD) || s.costUSD; break;
      case 'permission-mode': s.permissionMode = o.permissionMode || s.permissionMode; break;
      case 'user': {
        if (o.isMeta) break;
        if (o.permissionMode) s.permissionMode = o.permissionMode;
        const c = o.message && o.message.content;
        let text = null, isResult = false;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'tool_result') { isResult = true; pending.delete(b.tool_use_id); }
            else if (b.type === 'text' && text == null) text = b.text;
          }
        }
        if (!isResult) {
          s.userTurns++;
          const t = clean(text, 120);
          if (t) { if (!s.firstPrompt) s.firstPrompt = t; s.lastUserPrompt = t; }
        }
        break;
      }
      case 'assistant': {
        const m = o.message || {};
        s.lastError = !!o.isApiErrorMessage;
        if (m.model && m.model !== '<synthetic>') s.model = m.model;
        const day = o.timestamp ? localDay(o.timestamp) : null;
        const mid = m.id || o.uuid;
        if (m.usage && !o.isApiErrorMessage && !seenMsg.has(mid)) {
          seenMsg.add(mid);
          const u = m.usage;
          const t = {
            input: u.input_tokens || 0, output: u.output_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
          };
          const model = m.model && m.model !== '<synthetic>' ? m.model : (s.model || 'unknown');
          s.assistantTurns++;
          addCounts(s.tokens, t);
          if (day) {
            const b = bucket(s, day);
            b.turns++; addCounts(b, t);
            const mb = (b.models[model] ||= emptyCounts());
            mb.turns++; addCounts(mb, t);
          }
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type !== 'tool_use') continue;
            pending.set(b.id, { name: b.name, ts: o.timestamp });
            if (day && !seenTool.has(b.id)) {
              seenTool.add(b.id);
              const bk = bucket(s, day);
              bk.tools[b.name] = (bk.tools[b.name] || 0) + 1;
            }
          }
        }
        break;
      }
    }
  }
  s.startDay = s.startTs ? localDay(s.startTs) : null;
  s.pendingTools = [...pending.values()];
  return s;
}

// ---------- persistence ----------
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.version === CACHE_VERSION) for (const [k, v] of Object.entries(c.files)) index.set(k, v);
  } catch { /* no cache yet */ }
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(index) })); }
  catch { /* cache is optional */ }
}

async function runScan() {
  if (scan.running) return;
  scan.running = true;
  try {
    const files = listJsonl(PROJECTS_DIR);
    const live = new Set(files);
    for (const k of [...index.keys()]) if (!live.has(k)) index.delete(k);
    const todo = [];
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const cur = index.get(f);
      if (!cur || cur.mtime !== st.mtimeMs || cur.size !== st.size) todo.push([f, st]);
    }
    scan.done = 0; scan.total = todo.length;
    await pool(todo, 4, async ([f, st]) => {
      try { index.set(f, await summarize(f, st)); } catch { /* unreadable file: skip */ }
      scan.done++;
    });
    scan.complete = true;
    scan.lastScan = new Date().toISOString();
    if (todo.length) saveCache();
  } finally {
    scan.running = false;
  }
}

// ---------- views ----------
function sessionView(s, now) {
  const active = now - s.mtime < ACTIVE_MS;
  const recent = now - s.mtime < ATTENTION_MS;
  // Ignore stale unanswered tool calls: the oldest pending one must also be recent.
  const pendingFresh = s.pendingTools.length > 0 && now - Date.parse(s.pendingTools[0].ts) < ATTENTION_MS;
  let attention = null;
  if (recent && pendingFresh) {
    const names = [...new Set(s.pendingTools.map((t) => t.name))];
    if (names.includes('AskUserQuestion')) {
      attention = { kind: 'question', text: 'Claude asked you a question', since: s.pendingTools[0].ts };
    } else if (!active) {
      // A tool call with no result yet and the chat has gone quiet => it is waiting on approval.
      attention = { kind: 'approval', text: `Waiting for approval: ${names.join(', ')}`, since: s.pendingTools[0].ts };
    }
  } else if (recent && s.lastError && !active) {
    attention = { kind: 'error', text: 'Last reply failed with an error', since: s.endTs };
  }
  return {
    id: s.sessionId,
    title: s.customTitle || s.aiTitle || s.firstPrompt || s.sessionId.slice(0, 8),
    project: projectLabel(s.cwd),
    entrypoint: s.entrypoint,
    model: s.model,
    permissionMode: s.permissionMode,
    status: active ? 'active' : 'idle',
    lastActive: new Date(s.mtime).toISOString(),
    lastActiveMs: s.mtime,
    startedAt: s.startTs,
    userTurns: s.userTurns,
    assistantTurns: s.assistantTurns,
    tokens: s.tokens.input + s.tokens.output,
    cacheRead: s.tokens.cacheRead,
    costUSD: s.costUSD,
    lastPrompt: s.lastPrompt || s.lastUserPrompt,
    attention,
  };
}

function overview() {
  const now = Date.now();
  const today = localDay(now);
  const all = [...index.values()];
  const top = all.filter((s) => !s.isSubagent);
  const views = top.map((s) => sessionView(s, now)).sort((a, b) => b.lastActiveMs - a.lastActiveMs);

  let turnsToday = 0, tokensToday = 0;
  for (const s of all) {
    const b = s.daily[today];
    if (b) { turnsToday += b.turns; tokensToday += b.input + b.output; }
  }
  const todays = top.filter((s) => s.startDay === today);
  const attention = views.filter((v) => v.attention);

  return {
    generatedAt: new Date(now).toISOString(),
    scan: { ...scan },
    kpis: {
      active: views.filter((v) => v.status === 'active').length,
      attention: attention.length,
      sessionsToday: todays.length,
      turnsToday,
      tokensToday,
      costToday: todays.reduce((sum, s) => sum + s.costUSD, 0),
      totalSessions: top.length,
    },
    attention,
    active: views.filter((v) => v.status === 'active'),
    recent: views.slice(0, 60),
  };
}

function analytics(days) {
  const now = Date.now();
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(localDay(now - i * 86400000));
  const inRange = new Set(keys);
  const daily = Object.fromEntries(keys.map((k) => [k, { date: k, sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, tools: 0 }]));
  const totals = { sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, tools: 0 };
  const models = {}, tools = {}, entry = {}, projects = {};

  for (const s of index.values()) {
    let turns = 0, tokens = 0;
    for (const [day, b] of Object.entries(s.daily)) {
      if (!inRange.has(day)) continue;
      const d = daily[day];
      addCounts(d, b); addCounts(totals, b);
      turns += b.turns; tokens += b.input + b.output;
      for (const [name, c] of Object.entries(b.tools)) {
        tools[name] = (tools[name] || 0) + c;
        d.tools += c; totals.tools += c;
      }
      for (const [name, mb] of Object.entries(b.models)) addCounts((models[name] ||= emptyCounts()), mb);
    }
    if (!s.isSubagent && s.startDay && inRange.has(s.startDay)) {
      daily[s.startDay].sessions++;
      daily[s.startDay].costUSD += s.costUSD;
      totals.sessions++;
      totals.costUSD += s.costUSD;
    }
    if (turns) {
      const e = (entry[s.entrypoint || 'unknown'] ||= { sessions: 0, turns: 0 });
      e.turns += turns;
      if (!s.isSubagent) e.sessions++;
      const p = (projects[projectLabel(s.cwd)] ||= { sessions: 0, turns: 0, tokens: 0 });
      p.turns += turns; p.tokens += tokens;
      if (!s.isSubagent) p.sessions++;
    }
  }

  const byTurns = (a, b) => b.turns - a.turns;
  return {
    range: { days, from: keys[0], to: keys[keys.length - 1] },
    scan: { ...scan },
    totals,
    daily: keys.map((k) => daily[k]),
    models: Object.entries(models).map(([name, c]) => ({ name, ...c })).sort(byTurns),
    entrypoints: Object.entries(entry).map(([name, c]) => ({ name, ...c })).sort(byTurns),
    projects: Object.entries(projects).map(([name, c]) => ({ name, ...c })).sort(byTurns).slice(0, 15),
    tools: Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 15),
  };
}

// ---------- http ----------
function send(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname === '/api/overview') return send(res, overview());
    if (url.pathname === '/api/analytics') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
      return send(res, analytics(days));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) { res.writeHead(500); return res.end('index.html missing'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// One-shot mode for other hosts (the pane mod): `node server.js --json overview` or
// `node server.js --json analytics 30`. Prints JSON to stdout and exits.
const cliAt = process.argv.indexOf('--json');
if (cliAt !== -1) {
  const what = process.argv[cliAt + 1] || 'overview';
  const days = Math.min(365, Math.max(1, Number(process.argv[cliAt + 2]) || 30));
  loadCache();
  runScan()
    .then(() => process.stdout.write(JSON.stringify(what === 'analytics' ? analytics(days) : overview())))
    .catch((e) => { process.stderr.write(e.message); process.exitCode = 1; });
} else {
  loadCache();
  server.listen(PORT, HOST, () => {
    console.log(`Claude dashboard: http://${HOST}:${PORT}`);
    console.log(`Reading transcripts from: ${PROJECTS_DIR}`);
  });
  runScan().catch((e) => console.error('scan failed:', e.message));
  setInterval(() => runScan().catch((e) => console.error('scan failed:', e.message)), RESCAN_MS);
}
