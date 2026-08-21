import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { priceFor, costUsd } from '../prices.js';

const ZERO = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cw5m: 0, cw1h: 0 });

const SEEN_RETENTION_DAYS = 30;

function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function* jsonlFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function ingestLine(state, line) {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j.type !== 'assistant') return;
  const msg = j.message;
  const u = msg?.usage;
  const model = msg?.model;
  if (!u || !model || model === '<synthetic>') return;

  const key = `${msg.id ?? 'noid'}:${j.requestId ?? j.uuid ?? 'noreq'}`;
  if (state.seen[key]) return;

  const ts = new Date(j.timestamp ?? Date.now());
  const day = localDay(ts);
  state.seen[key] = day;

  const perDay = (state.days[day] ??= {});
  const b = (perDay[model] ??= ZERO());
  b.in += u.input_tokens ?? 0;
  b.out += u.output_tokens ?? 0;
  b.cacheRead += u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  b.cacheWrite += cw;
  const c5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const c1 = u.cache_creation?.ephemeral_1h_input_tokens;
  if (c5 != null || c1 != null) { b.cw5m += c5 ?? 0; b.cw1h += c1 ?? 0; }
  else b.cw5m += cw; // no breakdown: assume 5m pricing
}

// Read a file from `offset` to EOF, feed complete lines to ingestLine,
// return the new offset (end of the last complete line).
function readNewLines(state, path, offset, size) {
  const fd = openSync(path, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    let text = buf.toString('utf8');
    let consumed = len;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return offset; // no complete line yet
      consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
      text = text.slice(0, lastNl + 1);
    }
    for (const line of text.split('\n')) if (line.trim()) ingestLine(state, line);
    return offset + consumed;
  } finally { closeSync(fd); }
}

// Returns true when the scan changed `state` (advanced an offset, tracked a new file,
// or pruned a dedupe key). The daemon rewrites the whole ~1.4MB state file on every
// save, so it uses this to skip the writes that would persist nothing new.
export function scanClaudeTokens(state, { projectsDir, now = new Date() } = {}) {
  let changed = false;
  for (const path of jsonlFiles(projectsDir)) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const known = state.files[path] !== undefined;
    const rec = (state.files[path] ??= { offset: 0 });
    if (!known) changed = true;
    if (st.size < rec.offset) { rec.offset = 0; changed = true; } // truncated/rotated: rescan (dedupe prevents double counting)
    if (st.size > rec.offset) {
      // readNewLines returns the offset unchanged when there is no complete line yet.
      const next = readNewLines(state, path, rec.offset, st.size);
      if (next !== rec.offset) { rec.offset = next; changed = true; }
    }
  }
  // prune dedupe keys older than SEEN_RETENTION_DAYS to bound state size
  const cutoff = localDay(new Date(now.getTime() - SEEN_RETENTION_DAYS * 86400e3));
  for (const [k, day] of Object.entries(state.seen)) {
    if (day < cutoff) { delete state.seen[k]; changed = true; }
  }
  return changed;
}

const addTo = (acc, b) => {
  acc.in += b.in; acc.out += b.out; acc.cacheRead += b.cacheRead; acc.cacheWrite += b.cacheWrite;
};

export function tokenWindows(state, { now = new Date() } = {}) {
  const today = localDay(now);
  const weekDays = new Set();
  for (let i = 0; i < 7; i++) weekDays.add(localDay(new Date(now.getTime() - i * 86400e3)));
  const monthPrefix = today.slice(0, 7);

  const mk = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const w = { computedAt: new Date(now).toISOString(), today: mk(), week: mk(), month: mk(), allTime: mk(), costUsd: { month: 0, allTime: 0 } };

  for (const [day, models] of Object.entries(state.days)) {
    for (const [model, b] of Object.entries(models)) {
      addTo(w.allTime, b);
      if (day === today) addTo(w.today, b);
      if (weekDays.has(day)) addTo(w.week, b);
      if (day.startsWith(monthPrefix)) addTo(w.month, b);
      const price = priceFor(model);
      if (price) {
        const c = costUsd(b, price);
        w.costUsd.allTime += c;
        if (day.startsWith(monthPrefix)) w.costUsd.month += c;
      }
    }
  }
  for (const k of ['today', 'week', 'month', 'allTime']) {
    const b = w[k];
    b.total = b.in + b.out + b.cacheRead + b.cacheWrite;
  }
  w.costUsd.month = Math.round(w.costUsd.month * 100) / 100;
  w.costUsd.allTime = Math.round(w.costUsd.allTime * 100) / 100;
  return w;
}
