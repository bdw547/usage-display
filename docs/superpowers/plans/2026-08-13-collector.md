# Collector (Node.js daemon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js daemon that computes Claude token totals from local Claude Code logs, reads Claude/Codex limit percentages and Copilot quota using credentials the CLIs already maintain, and pushes a snapshot to the relay every 30 seconds.

**Architecture:** One process, zero runtime dependencies (Node 22 built-ins only: `fetch`, `node:fs`, `node:test`). Each vendor source is an isolated module with a pure `normalize*()` function tested against fixtures captured from the real APIs on 2026-08-13. Sources degrade independently: a failing source keeps its last good value; the push loop never stops. Never refreshes vendor OAuth tokens (read-only on credential files).

**Tech Stack:** Node 22 (installed via nvm at `~/.nvm/versions/node/v22.16.0/bin/node`), ES modules, `node --test`, systemd user service.

## Global Constraints

- Directory: `collector/` in the `usage-display` repo. `"type": "module"`. No npm runtime dependencies.
- Config file: `~/.config/usage-collector/config.json` → `{ "relayUrl", "pushToken", "machineId"? }` (machineId defaults to `os.hostname()`). The relay deploy step already wrote `~/.config/usage-collector/tokens.json` with `relayUrl`/`pushToken`/`readToken`; the config loader falls back to it.
- State file: `~/.local/share/usage-collector/state.json`, written atomically (tmp + rename).
- Snapshot schema v1 exactly as the relay expects (see relay plan Task 2 tests): token buckets are `{in, out, cacheRead, cacheWrite, total}`; sections may be null.
- Poll cadences: tokens scan + push every 30s; Anthropic limits every 5 min (honor `retry-after` on 429, never faster); Codex every 5 min; Copilot every 10 min.
- Never write to `~/.claude`, `~/.codex`, or `~/.config/github-copilot` — read-only.
- Timezone: system local time for day bucketing.
- Cost prices are per-MTok, hardcoded in `src/prices.js` (source: claude-api reference, cached 2026-06-24): cache read = 0.1 × input; cache write 5m = 1.25 × input; cache write 1h = 2 × input.

---

### Task 1: Scaffold package, config loader, and state store

**Files:**
- Create: `collector/package.json`
- Create: `collector/src/config.js`
- Create: `collector/src/state.js`
- Test: `collector/test/config.test.js`, `collector/test/state.test.js`

**Interfaces:**
- Produces: `loadConfig({env}) -> {relayUrl, pushToken, machineId}` (throws with a clear message if missing); `loadState(path) -> object` (returns `{files:{}, days:{}, seen:{}}` if absent/corrupt); `saveState(path, state)` (atomic). Consumed by every later task.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "usage-collector",
  "private": true,
  "type": "module",
  "bin": { "usage-collector": "src/index.js" },
  "scripts": { "test": "node --test test/" }
}
```

- [ ] **Step 2: Write the failing tests**

```js
// collector/test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function homeWith(files) {
  const home = mkdtempSync(join(tmpdir(), 'uc-'));
  mkdirSync(join(home, '.config/usage-collector'), { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    writeFileSync(join(home, '.config/usage-collector', name), JSON.stringify(obj));
  }
  return home;
}

test('reads config.json', () => {
  const home = homeWith({ 'config.json': { relayUrl: 'https://r.example', pushToken: 'p', machineId: 'box' } });
  const c = loadConfig({ home });
  assert.equal(c.relayUrl, 'https://r.example');
  assert.equal(c.machineId, 'box');
});

test('falls back to tokens.json (written by relay deploy) and defaults machineId to hostname', () => {
  const home = homeWith({ 'tokens.json': { relayUrl: 'https://r.example', pushToken: 'p', readToken: 'r' } });
  const c = loadConfig({ home });
  assert.equal(c.pushToken, 'p');
  assert.ok(c.machineId.length > 0);
});

test('throws a helpful error when nothing is configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'uc-'));
  assert.throws(() => loadConfig({ home }), /usage-collector\/config\.json/);
});
```

```js
// collector/test/state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.js';

test('round-trips state and tolerates missing/corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  const empty = loadState(p);
  assert.deepEqual(empty, { files: {}, days: {}, seen: {} });
  empty.days['2026-08-13'] = { 'claude-fable-5': { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, cw5m: 4, cw1h: 0 } };
  saveState(p, empty);
  const back = loadState(p);
  assert.equal(back.days['2026-08-13']['claude-fable-5'].out, 2);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement config.js and state.js**

```js
// collector/src/config.js
import { readFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

export function loadConfig({ home = homedir() } = {}) {
  const dir = join(home, '.config/usage-collector');
  let raw = null;
  for (const name of ['config.json', 'tokens.json']) {
    try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')); break; } catch { /* try next */ }
  }
  if (!raw || !raw.relayUrl || !raw.pushToken) {
    throw new Error(
      'Missing configuration. Create ~/.config/usage-collector/config.json with {"relayUrl": "...", "pushToken": "..."} ' +
      '(the relay deploy step writes tokens.json there, which also works).'
    );
  }
  return { relayUrl: raw.relayUrl.replace(/\/$/, ''), pushToken: raw.pushToken, machineId: raw.machineId || hostname() };
}
```

```js
// collector/src/state.js
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return { files: s.files ?? {}, days: s.days ?? {}, seen: s.seen ?? {} };
  } catch {
    return { files: {}, days: {}, seen: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add collector/ && git commit -m "feat(collector): scaffold with config loader and atomic state store"
```

---

### Task 2: Price table and cost math — TDD

**Files:**
- Create: `collector/src/prices.js`
- Test: `collector/test/prices.test.js`

**Interfaces:**
- Produces: `priceFor(modelId) -> {inP, outP} | null` (longest-prefix match, USD per MTok) and `costUsd(bucket, price) -> number` where bucket is `{in, out, cacheRead, cw5m, cw1h}`. Consumed by the token scanner (Task 3).

- [ ] **Step 1: Write the failing tests**

```js
// collector/test/prices.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costUsd } from '../src/prices.js';

test('longest-prefix model matching, date suffixes included', () => {
  assert.deepEqual(priceFor('claude-fable-5'), { inP: 10, outP: 50 });
  assert.deepEqual(priceFor('claude-opus-4-5-20251101'), { inP: 5, outP: 25 });
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), { inP: 15, outP: 75 });
  assert.deepEqual(priceFor('claude-sonnet-4-6'), { inP: 3, outP: 15 });
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { inP: 1, outP: 5 });
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor('mystery-model-9000'), null);
});

test('cost math: out + in + 0.1x cache read + 1.25x/2x cache writes, per MTok', () => {
  const price = { inP: 10, outP: 50 };
  // 1M of each bucket: 10 + 50 + 1 + 12.5 + 20 = 93.5
  const c = costUsd({ in: 1e6, out: 1e6, cacheRead: 1e6, cw5m: 1e6, cw1h: 1e6 }, price);
  assert.ok(Math.abs(c - 93.5) < 1e-9, `got ${c}`);
  assert.equal(costUsd({ in: 0, out: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, price), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — `Cannot find module '../src/prices.js'`

- [ ] **Step 3: Implement prices.js**

```js
// collector/src/prices.js
// USD per million tokens. Source: claude-api skill reference (cached 2026-06-24).
// Costs are ESTIMATES at API list prices — subscription usage isn't literally billed this way.
const PRICES = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4-2', 15, 75],
  ['claude-opus-4-0', 15, 75],
  ['claude-opus-4-20250514', 15, 75],
  ['claude-3-opus', 15, 75],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
].sort((a, b) => b[0].length - a[0].length); // longest prefix first

export function priceFor(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const hit = PRICES.find(([prefix]) => modelId.startsWith(prefix));
  return hit ? { inP: hit[1], outP: hit[2] } : null;
}

export function costUsd(b, { inP, outP }) {
  return (
    (b.in ?? 0) * inP +
    (b.out ?? 0) * outP +
    (b.cacheRead ?? 0) * inP * 0.1 +
    (b.cw5m ?? 0) * inP * 1.25 +
    (b.cw1h ?? 0) * inP * 2
  ) / 1e6;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add collector/src/prices.js collector/test/prices.test.js
git commit -m "feat(collector): model price table and cost estimation"
```

---

### Task 3: Claude token scanner (incremental JSONL) — TDD

**Files:**
- Create: `collector/src/sources/claude-tokens.js`
- Create: `collector/test/fixtures/claude-projects/proj-a/session1.jsonl`
- Create: `collector/test/fixtures/claude-projects/proj-b/session2.jsonl`
- Test: `collector/test/claude-tokens.test.js`

**Interfaces:**
- Consumes: `state` object from Task 1 (`state.files`, `state.days`, `state.seen` are mutated in place), `priceFor`/`costUsd` from Task 2.
- Produces: `scanClaudeTokens(state, {projectsDir, now}) -> void` (updates state) and `tokenWindows(state, {now}) -> {computedAt, today, week, month, allTime, costUsd:{month,allTime}}` in snapshot-v1 shape. Consumed by the assembler (Task 7).

**Facts this encodes (verified against live logs 2026-08-13):** assistant lines look like `{"type":"assistant","uuid":"...","requestId":"req_...","timestamp":"ISO","message":{"id":"msg_...","model":"claude-fable-5","usage":{"input_tokens":2,"cache_creation_input_tokens":44874,"cache_read_input_tokens":0,"output_tokens":2806,"cache_creation":{"ephemeral_1h_input_tokens":44874,"ephemeral_5m_input_tokens":0}}}}`. Dedupe key = `message.id + ":" + (requestId || uuid)`, first occurrence wins (ccusage semantics; duplicates appear when sessions are resumed/continued into new files). Skip `model === "<synthetic>"` (error placeholder lines) and lines without `message.usage`.

- [ ] **Step 1: Write the fixtures**

`collector/test/fixtures/claude-projects/proj-a/session1.jsonl` — exactly these 5 lines (day bucketing uses the local-noon timestamps to be TZ-safe in tests):

```
{"type":"user","uuid":"u0","timestamp":"2026-08-13T12:00:00","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"a1","requestId":"req_1","timestamp":"2026-08-13T12:00:05","message":{"id":"msg_1","model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":1000,"cache_creation_input_tokens":400,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":300}}}}
{"type":"assistant","uuid":"a2","requestId":"req_1","timestamp":"2026-08-13T12:00:06","message":{"id":"msg_1","model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":1000,"cache_creation_input_tokens":400}}}
{"type":"assistant","uuid":"a3","requestId":"req_2","timestamp":"2026-08-13T12:10:00","message":{"id":"msg_2","model":"<synthetic>","usage":{"input_tokens":5,"output_tokens":5}}}
{"type":"assistant","uuid":"a4","requestId":"req_3","timestamp":"2026-08-10T12:00:00","message":{"id":"msg_3","model":"claude-opus-4-5-20251101","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

`collector/test/fixtures/claude-projects/proj-b/session2.jsonl` — 1 line, an old month for window testing:

```
{"type":"assistant","uuid":"b1","requestId":"req_9","timestamp":"2026-07-01T12:00:00","message":{"id":"msg_9","model":"claude-fable-5","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 2: Write the failing tests**

```js
// collector/test/claude-tokens.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanClaudeTokens, tokenWindows } from '../src/sources/claude-tokens.js';

const FIXTURES = new URL('./fixtures/claude-projects', import.meta.url).pathname;
const NOW = new Date('2026-08-13T20:00:00'); // local time
const freshState = () => ({ files: {}, days: {}, seen: {} });

test('scan aggregates per-day per-model, dedupes, skips synthetic and non-assistant lines', () => {
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: FIXTURES, now: NOW });
  const d13 = state.days['2026-08-13']['claude-fable-5'];
  assert.equal(d13.in, 100, 'duplicate msg_1/req_1 counted once');
  assert.equal(d13.out, 200);
  assert.equal(d13.cacheRead, 1000);
  assert.equal(d13.cw5m, 100);
  assert.equal(d13.cw1h, 300);
  assert.ok(!state.days['2026-08-13']['<synthetic>'], 'synthetic model skipped');
  assert.equal(state.days['2026-08-10']['claude-opus-4-5-20251101'].out, 20);
  assert.equal(state.days['2026-07-01']['claude-fable-5'].out, 2000);
});

test('incremental: second scan reads nothing new; appended line is picked up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-proj-'));
  cpSync(FIXTURES, dir, { recursive: true });
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  const before = JSON.stringify(state.days);
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  assert.equal(JSON.stringify(state.days), before, 'no double counting on rescan');
  appendFileSync(join(dir, 'proj-a/session1.jsonl'),
    '\n{"type":"assistant","uuid":"a9","requestId":"req_10","timestamp":"2026-08-13T13:00:00","message":{"id":"msg_10","model":"claude-fable-5","usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  assert.equal(state.days['2026-08-13']['claude-fable-5'].in, 107);
});

test('windows: today / rolling-7d / calendar month / all-time + cost', () => {
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: FIXTURES, now: NOW });
  const w = tokenWindows(state, { now: NOW });
  // today (2026-08-13, fable): in100 out200 cr1000 cw400 => total 1700
  assert.equal(w.today.total, 1700);
  // week = 8/07..8/13 → includes 8/10 opus (10+20) and today's 1700 → 1730
  assert.equal(w.week.total, 1730);
  // month = 2026-08 → same as week here
  assert.equal(w.month.total, 1730);
  // all time adds July's 3000
  assert.equal(w.allTime.total, 4730);
  // cost: fable today = (100*10 + 200*50 + 1000*10*0.1 + 100*10*1.25 + 300*10*2)/1e6
  //     = (1000 + 10000 + 1000 + 1250 + 6000)/1e6 = 0.01925
  // opus 4.5 (8/10) = (10*5 + 20*25)/1e6 = 0.00055 ; July fable = (1000*10+2000*50)/1e6 = 0.11
  assert.ok(Math.abs(w.costUsd.month - 0.0198) < 0.0001, `month ${w.costUsd.month}`);
  assert.ok(Math.abs(w.costUsd.allTime - 0.1298) < 0.0001, `allTime ${w.costUsd.allTime}`);
  assert.ok(w.computedAt);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — module not found

- [ ] **Step 4: Implement claude-tokens.js**

```js
// collector/src/sources/claude-tokens.js
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { priceFor, costUsd } from '../prices.js';

const ZERO = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cw5m: 0, cw1h: 0 });

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

export function scanClaudeTokens(state, { projectsDir, now = new Date() } = {}) {
  for (const path of jsonlFiles(projectsDir)) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const rec = (state.files[path] ??= { offset: 0 });
    if (st.size < rec.offset) rec.offset = 0; // truncated/rotated: rescan (dedupe prevents double counting)
    if (st.size > rec.offset) rec.offset = readNewLines(state, path, rec.offset, st.size);
  }
  // prune dedupe keys older than 30 days to bound state size
  const cutoff = localDay(new Date(now.getTime() - 30 * 86400e3));
  for (const [k, day] of Object.entries(state.seen)) if (day < cutoff) delete state.seen[k];
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS (if the cost assertions are off by a tiny epsilon, fix the test tolerance, not the math)

- [ ] **Step 6: Sanity-run against the real logs on this machine (read-only)**

Run: `cd collector && node -e "import('./src/sources/claude-tokens.js').then(m => { const s = {files:{},days:{},seen:{}}; m.scanClaudeTokens(s, {projectsDir: process.env.HOME + '/.claude/projects'}); const w = m.tokenWindows(s, {}); console.log(JSON.stringify(w, null, 1)); })"`
Expected: prints real token windows with plausible non-zero numbers for today (this session's usage exists); no exceptions.

- [ ] **Step 7: Commit**

```bash
git add collector/src/sources/claude-tokens.js collector/test/
git commit -m "feat(collector): incremental Claude Code JSONL token scanner with windows and cost"
```

---

### Task 4: Claude limits source — TDD

**Files:**
- Create: `collector/src/sources/claude-limits.js`
- Create: `collector/test/fixtures/anthropic-usage.json`
- Test: `collector/test/claude-limits.test.js`

**Interfaces:**
- Produces: `normalizeAnthropicUsage(body, nowIso) -> {fetchedAt, session:{pct,resetsAt}|null, weekly:{pct,resetsAt}|null, extra:[{label,pct,resetsAt}]}` (pure) and `fetchClaudeLimits({home, fetchImpl, now}) -> Promise<normalized|null>` (reads `~/.claude/.credentials.json`, calls `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`; returns null on expired token/429/network — caller keeps last value). Consumed by Task 7.
- Rate limiting: module tracks `nextAllowedAt` internally; on 429 it honors `retry-after` (min 300s). `fetchClaudeLimits` returns null when called before `nextAllowedAt`.

- [ ] **Step 1: Write the fixture** — real response shape captured live 2026-08-13 (values kept, org ids not present in this endpoint):

```json
{
  "five_hour": { "utilization": 13, "resets_at": "2026-08-13T19:30:00.266130+00:00" },
  "seven_day": { "utilization": 51, "resets_at": "2026-08-16T09:00:00.266154+00:00" },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "extra_usage": { "is_enabled": true, "used_credits": 0 },
  "limits": [
    { "kind": "session", "group": "session", "percent": 13, "severity": "normal", "resets_at": "2026-08-13T19:30:00.266130+00:00", "scope": null, "is_active": false },
    { "kind": "weekly_all", "group": "weekly", "percent": 51, "severity": "normal", "resets_at": "2026-08-16T09:00:00.266154+00:00", "scope": null, "is_active": false },
    { "kind": "weekly_scoped", "group": "weekly", "percent": 30, "severity": "normal", "resets_at": "2026-08-16T09:00:00.266154+00:00", "scope": "opus", "is_active": true }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

```js
// collector/test/claude-limits.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAnthropicUsage } from '../src/sources/claude-limits.js';

const body = JSON.parse(readFileSync(new URL('./fixtures/anthropic-usage.json', import.meta.url), 'utf8'));
const NOW = '2026-08-13T16:00:00.000Z';

test('prefers the limits[] array: session, weekly_all, scoped extras', () => {
  const n = normalizeAnthropicUsage(body, NOW);
  assert.equal(n.fetchedAt, NOW);
  assert.equal(n.session.pct, 13);
  assert.ok(n.session.resetsAt.startsWith('2026-08-13T19:30:00'));
  assert.equal(n.weekly.pct, 51);
  assert.deepEqual(n.extra.map((e) => e.label), ['opus']);
  assert.equal(n.extra[0].pct, 30);
});

test('falls back to five_hour/seven_day when limits[] is absent', () => {
  const legacy = { five_hour: { utilization: 7, resets_at: '2026-08-13T19:30:00Z' }, seven_day: { utilization: 60, resets_at: '2026-08-16T09:00:00Z' } };
  const n = normalizeAnthropicUsage(legacy, NOW);
  assert.equal(n.session.pct, 7);
  assert.equal(n.weekly.pct, 60);
  assert.deepEqual(n.extra, []);
});

test('handles a fully empty body without throwing', () => {
  const n = normalizeAnthropicUsage({}, NOW);
  assert.equal(n.session, null);
  assert.equal(n.weekly, null);
  assert.deepEqual(n.extra, []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — module not found

- [ ] **Step 4: Implement claude-limits.js**

```js
// collector/src/sources/claude-limits.js
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function normalizeAnthropicUsage(body, fetchedAt) {
  const out = { fetchedAt, session: null, weekly: null, extra: [] };
  if (Array.isArray(body?.limits) && body.limits.length > 0) {
    for (const l of body.limits) {
      if (l?.percent == null) continue;
      const w = { pct: l.percent, resetsAt: l.resets_at ?? null };
      if (l.kind === 'session') out.session = w;
      else if (l.kind === 'weekly_all') out.weekly = w;
      else out.extra.push({ label: l.scope ?? String(l.kind ?? 'other').replace(/^weekly_/, ''), ...w });
    }
  }
  if (!out.session && body?.five_hour?.utilization != null) {
    out.session = { pct: body.five_hour.utilization, resetsAt: body.five_hour.resets_at ?? null };
  }
  if (!out.weekly && body?.seven_day?.utilization != null) {
    out.weekly = { pct: body.seven_day.utilization, resetsAt: body.seven_day.resets_at ?? null };
  }
  return out;
}

let nextAllowedAt = 0; // module-level backoff; this endpoint 429s aggressive pollers

export async function fetchClaudeLimits({ home = homedir(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (now() < nextAllowedAt) return null;
  let creds;
  try { creds = JSON.parse(readFileSync(join(home, '.claude/.credentials.json'), 'utf8')); } catch { return null; }
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && oauth.expiresAt < now()) return null; // stale token: Claude Code refreshes it on next use

  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    });
  } catch { return null; }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    nextAllowedAt = now() + Math.max(retryAfter, 300) * 1000;
    return null;
  }
  if (!res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  return normalizeAnthropicUsage(body, new Date(now()).toISOString());
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS

- [ ] **Step 6: One live smoke call (single request — this endpoint rate-limits)**

Run: `cd collector && node -e "import('./src/sources/claude-limits.js').then(async (m) => console.log(JSON.stringify(await m.fetchClaudeLimits(), null, 1)))"`
Expected: prints `{fetchedAt, session:{pct,...}, weekly:{pct,...}, extra:[...]}` with plausible percentages (or null if the token happens to be expired — also acceptable; note which happened).

- [ ] **Step 7: Commit**

```bash
git add collector/src/sources/claude-limits.js collector/test/
git commit -m "feat(collector): Anthropic OAuth usage limits source with 429 backoff"
```

---

### Task 5: Codex limits source — TDD

**Files:**
- Create: `collector/src/sources/codex.js`
- Create: `collector/test/fixtures/codex-rollout.jsonl`
- Test: `collector/test/codex.test.js`

**Interfaces:**
- Produces: `normalizeCodexRateLimits(rateLimits, fetchedAt) -> {fetchedAt, fiveHour|null, weekly|null, plan}` (pure; classifies windows by `window_minutes`, never by primary/secondary position) and `fetchCodexLimits({home, fetchImpl, now}) -> Promise<normalized|null>` — tries `https://chatgpt.com/backend-api/wham/usage` with the token from `~/.codex/auth.json`, falls back to scanning the newest `rollout-*.jsonl` under `~/.codex/sessions/` for the last `token_count` event (using that line's own `timestamp` as `fetchedAt`, so staleness is honest). Consumed by Task 7.

**Facts this encodes (verified live 2026-08-13):** rollout lines: `{"timestamp":"ISO","type":"event_msg","payload":{"type":"token_count","info":{...},"rate_limits":{"primary":{"used_percent":27,"window_minutes":10080,"resets_at":1786401348},"secondary":null,"plan_type":"plus"}}}`. Note `primary` here is the WEEKLY window (10080 min) — position is meaningless, classify by `window_minutes` (≤600 → fiveHour, >600 → weekly). `resets_at` is epoch seconds. The API token expires quickly when Codex isn't used (`401 token_expired` observed) — that's why rollout fallback is required.

- [ ] **Step 1: Write the fixture** `collector/test/fixtures/codex-rollout.jsonl` (3 lines: noise, an old rate_limits, the latest rate_limits with both windows):

```
{"timestamp":"2026-08-06T03:40:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"hello"}}
{"timestamp":"2026-08-06T03:45:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":20,"window_minutes":10080,"resets_at":1786401348},"secondary":null,"plan_type":"plus"}}}
{"timestamp":"2026-08-06T03:51:54.981Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":2363401}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":27,"window_minutes":10080,"resets_at":1786401348},"secondary":{"used_percent":9,"window_minutes":300,"resets_at":1786000000},"plan_type":"plus"}}}
```

- [ ] **Step 2: Write the failing tests**

```js
// collector/test/codex.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexRateLimits, latestRolloutRateLimits } from '../src/sources/codex.js';

const NOW = '2026-08-13T16:00:00.000Z';

test('classifies windows by window_minutes, not by primary/secondary position', () => {
  const n = normalizeCodexRateLimits(
    { primary: { used_percent: 27, window_minutes: 10080, resets_at: 1786401348 }, secondary: { used_percent: 9, window_minutes: 300, resets_at: 1786000000 }, plan_type: 'plus' },
    NOW,
  );
  assert.equal(n.weekly.pct, 27, 'the 10080-minute window is weekly even though it was primary');
  assert.equal(n.fiveHour.pct, 9);
  assert.equal(n.weekly.resetsAt, new Date(1786401348 * 1000).toISOString());
  assert.equal(n.plan, 'plus');
  assert.equal(n.fetchedAt, NOW);
});

test('tolerates missing windows', () => {
  const n = normalizeCodexRateLimits({ primary: null, secondary: null, plan_type: null }, NOW);
  assert.equal(n.fiveHour, null);
  assert.equal(n.weekly, null);
});

test('latestRolloutRateLimits pulls the newest token_count line and uses ITS timestamp', () => {
  const dir = new URL('./fixtures', import.meta.url).pathname;
  const hit = latestRolloutRateLimits(dir);
  assert.ok(hit, 'found a rate_limits line');
  assert.equal(hit.fetchedAt, '2026-08-06T03:51:54.981Z');
  assert.equal(hit.rateLimits.primary.used_percent, 27);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — module not found

- [ ] **Step 4: Implement codex.js**

```js
// collector/src/sources/codex.js
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function toIso(resetsAt) {
  if (resetsAt == null) return null;
  if (typeof resetsAt === 'number') return new Date(resetsAt * 1000).toISOString(); // epoch seconds
  return String(resetsAt);
}

export function normalizeCodexRateLimits(rl, fetchedAt) {
  const out = { fetchedAt, fiveHour: null, weekly: null, plan: rl?.plan_type ?? null };
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || w.used_percent == null) continue;
    const win = { pct: w.used_percent, resetsAt: toIso(w.resets_at) };
    if ((w.window_minutes ?? 0) <= 600) out.fiveHour = win;
    else out.weekly = win;
  }
  return out;
}

// Scan the newest rollout file(s) for the last token_count line carrying rate_limits.
export function latestRolloutRateLimits(sessionsDir) {
  let files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(sessionsDir);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const f of files.slice(0, 5)) {
    let lines;
    try { lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const j = JSON.parse(lines[i]);
        const rl = j?.payload?.rate_limits;
        if (rl) return { rateLimits: rl, fetchedAt: j.timestamp ?? null };
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

export async function fetchCodexLimits({ home = homedir(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  // 1) Try the live endpoint with the CLI's current token (never refresh it ourselves).
  try {
    const auth = JSON.parse(readFileSync(join(home, '.codex/auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    if (token) {
      const res = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': account ?? '', 'user-agent': 'codex_cli_rs' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = await res.json();
        const rl = body?.rate_limits ?? body?.rateLimits ?? body;
        if (rl && (rl.primary || rl.secondary)) {
          return normalizeCodexRateLimits(rl, new Date(now()).toISOString());
        }
      }
    }
  } catch { /* fall through to rollout files */ }

  // 2) Fallback: last known values from the newest session rollout file.
  const hit = latestRolloutRateLimits(join(home, '.codex/sessions'));
  if (hit) return normalizeCodexRateLimits(hit.rateLimits, hit.fetchedAt);
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS

- [ ] **Step 6: Live smoke (expected to use the rollout fallback since the token was observed expired)**

Run: `cd collector && node -e "import('./src/sources/codex.js').then(async (m) => console.log(JSON.stringify(await m.fetchCodexLimits(), null, 1)))"`
Expected: JSON with `weekly.pct` = 27-ish and `fetchedAt` around 2026-08-06 (from the rollout file), OR fresher numbers if the endpoint worked. Either proves the chain.

- [ ] **Step 7: Commit**

```bash
git add collector/src/sources/codex.js collector/test/
git commit -m "feat(collector): Codex limits via endpoint with rollout-file fallback"
```

---

### Task 6: Copilot quota source — TDD

**Files:**
- Create: `collector/src/sources/copilot.js`
- Create: `collector/test/fixtures/copilot-user.json`
- Test: `collector/test/copilot.test.js`

**Interfaces:**
- Produces: `normalizeCopilotUser(body, fetchedAt) -> {fetchedAt, used, included, pctUsed, resetsAt, plan} | null` (null when no premium_interactions snapshot) and `fetchCopilotQuota({home, fetchImpl, now, execImpl}) -> Promise<normalized|null>`. Token discovery order: `gh auth token` subprocess → `~/.config/github-copilot/apps.json` `oauth_token` values. Endpoint: `GET https://api.github.com/copilot_internal/user` (works for org-paid seats — verified live with this user's business seat). Consumed by Task 7.

- [ ] **Step 1: Write the fixture** `collector/test/fixtures/copilot-user.json` (trimmed live capture, 2026-08-13; analytics id scrubbed):

```json
{
  "login": "ben-abeo",
  "copilot_plan": "business",
  "quota_reset_date": "2026-09-01",
  "quota_reset_date_utc": "2026-09-01T00:00:00.000Z",
  "quota_snapshots": {
    "chat": { "unlimited": true, "percent_remaining": 100, "entitlement": 0, "remaining": 0, "credits_used": 0 },
    "completions": { "unlimited": true, "percent_remaining": 100, "entitlement": 0, "remaining": 0, "credits_used": 0 },
    "premium_interactions": { "unlimited": false, "percent_remaining": 68.4, "entitlement": 30000, "remaining": 20541, "credits_used": 9459, "overage_permitted": true }
  }
}
```

- [ ] **Step 2: Write the failing tests**

```js
// collector/test/copilot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCopilotUser } from '../src/sources/copilot.js';

const body = JSON.parse(readFileSync(new URL('./fixtures/copilot-user.json', import.meta.url), 'utf8'));
const NOW = '2026-08-13T16:00:00.000Z';

test('extracts premium interactions quota', () => {
  const n = normalizeCopilotUser(body, NOW);
  assert.equal(n.used, 9459);
  assert.equal(n.included, 30000);
  assert.ok(Math.abs(n.pctUsed - 31.6) < 0.01, `pctUsed ${n.pctUsed}`);
  assert.equal(n.resetsAt, '2026-09-01T00:00:00.000Z');
  assert.equal(n.plan, 'business');
});

test('unlimited premium plan reports pctUsed 0 with null included', () => {
  const b = { ...body, quota_snapshots: { premium_interactions: { unlimited: true, percent_remaining: 100, entitlement: 0, remaining: 0, credits_used: 123 } } };
  const n = normalizeCopilotUser(b, NOW);
  assert.equal(n.included, null);
  assert.equal(n.used, 123);
  assert.equal(n.pctUsed, 0);
});

test('returns null when there is no snapshot at all', () => {
  assert.equal(normalizeCopilotUser({ login: 'x' }, NOW), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — module not found

- [ ] **Step 4: Implement copilot.js**

```js
// collector/src/sources/copilot.js
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function normalizeCopilotUser(body, fetchedAt) {
  const q = body?.quota_snapshots?.premium_interactions;
  if (!q) return null;
  const unlimited = q.unlimited === true;
  return {
    fetchedAt,
    used: q.credits_used ?? null,
    included: unlimited ? null : q.entitlement ?? null,
    pctUsed: unlimited ? 0 : Math.round((100 - (q.percent_remaining ?? 100)) * 10) / 10,
    resetsAt: body.quota_reset_date_utc ?? (body.quota_reset_date ? `${body.quota_reset_date}T00:00:00.000Z` : null),
    plan: body.copilot_plan ?? null,
  };
}

function discoverToken({ home, execImpl }) {
  try {
    const t = execImpl('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    if (t) return t;
  } catch { /* gh not installed or not logged in */ }
  try {
    const apps = JSON.parse(readFileSync(join(home, '.config/github-copilot/apps.json'), 'utf8'));
    for (const v of Object.values(apps)) if (v?.oauth_token) return v.oauth_token;
  } catch { /* no copilot config */ }
  return null;
}

export async function fetchCopilotQuota({ home = homedir(), fetchImpl = fetch, now = () => Date.now(), execImpl = execFileSync } = {}) {
  const token = discoverToken({ home, execImpl });
  if (!token) return null;
  let res;
  try {
    res = await fetchImpl('https://api.github.com/copilot_internal/user', {
      headers: { authorization: `token ${token}`, 'user-agent': 'GitHubCopilotChat/0.26', 'editor-version': 'vscode/1.99.0' },
      signal: AbortSignal.timeout(15000),
    });
  } catch { return null; }
  if (!res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  return normalizeCopilotUser(body, new Date(now()).toISOString());
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS

- [ ] **Step 6: Live smoke**

Run: `cd collector && node -e "import('./src/sources/copilot.js').then(async (m) => console.log(JSON.stringify(await m.fetchCopilotQuota(), null, 1)))"`
Expected: real quota JSON — `used` ≈ 9459+, `included` 30000, `plan` "business".

- [ ] **Step 7: Commit**

```bash
git add collector/src/sources/copilot.js collector/test/
git commit -m "feat(collector): Copilot premium-request quota via copilot_internal/user"
```

---

### Task 7: Snapshot assembly, push, and the daemon loop — TDD assembly, then CLI

**Files:**
- Create: `collector/src/snapshot.js`
- Create: `collector/src/push.js`
- Create: `collector/src/index.js`
- Test: `collector/test/snapshot.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildSnapshot(cache, {machineId, now}) -> snapshot v1` where `cache = {claudeLimits, claudeTokens, codexLimits, copilotQuota}` (each the last good normalized value or null); `pushSnapshot(snapshot, {relayUrl, pushToken, fetchImpl}) -> Promise<boolean>`; CLI `node src/index.js [--once] [--print]`. The systemd unit (Task 8) runs `src/index.js` with no flags.

- [ ] **Step 1: Write the failing test**

```js
// collector/test/snapshot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/snapshot.js';
import { pushSnapshot } from '../src/push.js';

test('buildSnapshot produces schema v1 with nulls for missing sources', () => {
  const s = buildSnapshot(
    { claudeLimits: { fetchedAt: 'T', session: { pct: 1, resetsAt: 'R' }, weekly: null, extra: [] }, claudeTokens: null, codexLimits: null, copilotQuota: null },
    { machineId: 'box', now: new Date('2026-08-13T16:00:00Z') },
  );
  assert.equal(s.v, 1);
  assert.equal(s.machineId, 'box');
  assert.equal(s.sentAt, '2026-08-13T16:00:00.000Z');
  assert.equal(s.claude.limits.session.pct, 1);
  assert.equal(s.claude.tokens, null);
  assert.equal(s.codex.limits, null);
  assert.equal(s.copilot.quota, null);
});

test('pushSnapshot POSTs with bearer auth and reports success', async () => {
  let captured;
  const fakeFetch = async (url, opts) => { captured = { url, opts }; return new Response('{"ok":true}', { status: 200 }); };
  const ok = await pushSnapshot({ v: 1, machineId: 'box' }, { relayUrl: 'https://r.example', pushToken: 'tok', fetchImpl: fakeFetch });
  assert.equal(ok, true);
  assert.equal(captured.url, 'https://r.example/v1/push');
  assert.equal(captured.opts.headers.authorization, 'Bearer tok');
  assert.equal(JSON.parse(captured.opts.body).machineId, 'box');
});

test('pushSnapshot returns false on HTTP error and network error', async () => {
  assert.equal(await pushSnapshot({ v: 1 }, { relayUrl: 'https://r.example', pushToken: 't', fetchImpl: async () => new Response('no', { status: 500 }) }), false);
  assert.equal(await pushSnapshot({ v: 1 }, { relayUrl: 'https://r.example', pushToken: 't', fetchImpl: async () => { throw new Error('net'); } }), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npm test`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement snapshot.js and push.js**

```js
// collector/src/snapshot.js
export function buildSnapshot(cache, { machineId, now = new Date() }) {
  return {
    v: 1,
    machineId,
    sentAt: new Date(now).toISOString(),
    claude: { limits: cache.claudeLimits ?? null, tokens: cache.claudeTokens ?? null },
    codex: { limits: cache.codexLimits ?? null },
    copilot: { quota: cache.copilotQuota ?? null },
  };
}
```

```js
// collector/src/push.js
export async function pushSnapshot(snapshot, { relayUrl, pushToken, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${relayUrl}/v1/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pushToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement the daemon entry point index.js**

```js
#!/usr/bin/env node
// collector/src/index.js — usage-collector daemon.
// Flags: --once (single cycle then exit), --print (print snapshot to stdout), --no-push
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { scanClaudeTokens, tokenWindows } from './sources/claude-tokens.js';
import { fetchClaudeLimits } from './sources/claude-limits.js';
import { fetchCodexLimits } from './sources/codex.js';
import { fetchCopilotQuota } from './sources/copilot.js';
import { buildSnapshot } from './snapshot.js';
import { pushSnapshot } from './push.js';

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has('--once');
const PRINT = ARGS.has('--print');
const NO_PUSH = ARGS.has('--no-push');

const HOME = homedir();
const STATE_PATH = join(HOME, '.local/share/usage-collector/state.json');
const PROJECTS_DIR = join(HOME, '.claude/projects');

const PUSH_EVERY_MS = 30_000;
const POLLS = [
  { key: 'claudeLimits', everyMs: 5 * 60_000, fn: () => fetchClaudeLimits() },
  { key: 'codexLimits', everyMs: 5 * 60_000, fn: () => fetchCodexLimits() },
  { key: 'copilotQuota', everyMs: 10 * 60_000, fn: () => fetchCopilotQuota() },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const config = loadConfig();
  const state = loadState(STATE_PATH);
  const cache = { claudeLimits: null, claudeTokens: null, codexLimits: null, copilotQuota: null };
  const nextAt = Object.fromEntries(POLLS.map((p) => [p.key, 0]));
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  log(`usage-collector starting: machine=${config.machineId} relay=${config.relayUrl}`);

  do {
    const cycleStart = Date.now();

    // 1) Local token scan (cheap; every cycle)
    try {
      scanClaudeTokens(state, { projectsDir: PROJECTS_DIR });
      cache.claudeTokens = tokenWindows(state, {});
      saveState(STATE_PATH, state);
    } catch (err) {
      log('token scan failed:', err.message);
    }

    // 2) Vendor polls on their own cadences; failures keep the last good value
    for (const p of POLLS) {
      if (Date.now() < nextAt[p.key] && !ONCE) continue;
      nextAt[p.key] = Date.now() + p.everyMs + Math.floor(Math.random() * 15_000); // jitter
      try {
        const v = await p.fn();
        if (v) cache[p.key] = v;
        else log(`${p.key}: no fresh data (kept last value)`);
      } catch (err) {
        log(`${p.key} failed:`, err.message);
      }
    }

    // 3) Assemble + push
    const snapshot = buildSnapshot(cache, { machineId: config.machineId });
    if (PRINT) console.log(JSON.stringify(snapshot, null, 2));
    if (!NO_PUSH) {
      const ok = await pushSnapshot(snapshot, config);
      if (!ok) log('push failed (will retry next cycle)');
    }

    if (ONCE) break;
    const sleep = Math.max(1000, PUSH_EVERY_MS - (Date.now() - cycleStart));
    await new Promise((r) => setTimeout(r, sleep));
  } while (!stopping);

  saveState(STATE_PATH, state);
  log('usage-collector stopped');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 5: Run unit tests**

Run: `cd collector && npm test`
Expected: PASS — all collector suites green

- [ ] **Step 6: Full live single-cycle run (pushes one real snapshot to the deployed relay)**

Run: `cd collector && node src/index.js --once --print`
Expected: prints a complete snapshot with real Claude tokens, Claude limits (or kept-last-null), Codex from rollout, Copilot quota; exits 0. Then verify it landed:

Run: `READ=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/usage-collector/tokens.json')).readToken)") && RELAY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/usage-collector/tokens.json')).relayUrl)") && curl -s "$RELAY/v1/summary" -H "Authorization: Bearer $READ"`
Expected: summary JSON now contains this machine with fresh `ageSec` and real numbers.

- [ ] **Step 7: Commit**

```bash
git add collector/src/ collector/test/snapshot.test.js
git commit -m "feat(collector): snapshot assembly, relay push, and daemon loop with --once/--print"
```

---

### Task 8: systemd user service + installer + README

**Files:**
- Create: `collector/install/usage-collector.service`
- Create: `collector/install/install.sh`
- Create: `collector/README.md`

**Interfaces:**
- Produces: running `systemd --user` unit `usage-collector.service` on this machine; documented install path for future machines.

- [ ] **Step 1: Write the unit file** (`%h` = home; node path resolved by installer via sed placeholder)

```ini
# collector/install/usage-collector.service
[Unit]
Description=AI usage collector (Claude/Codex/Copilot -> relay)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=__NODE__ %h/usage-display/collector/src/index.js
Restart=always
RestartSec=15
Environment=NODE_ENV=production
# Keep it read-only outside its own state dir
ProtectSystem=strict
ReadWritePaths=%h/.local/share/usage-collector
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write install.sh**

```bash
#!/usr/bin/env bash
# collector/install/install.sh — install the collector as a systemd user service.
set -euo pipefail
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node not found in PATH"; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|__NODE__|$NODE_BIN|" "$(dirname "$0")/usage-collector.service" > "$UNIT_DIR/usage-collector.service"
systemctl --user daemon-reload
systemctl --user enable --now usage-collector.service
systemctl --user status usage-collector.service --no-pager || true
echo
echo "If this machine isn't a desktop session (e.g. headless/WSL), enable lingering so the service"
echo "runs without a login session:  sudo loginctl enable-linger $USER"
```

- [ ] **Step 3: Write collector/README.md**

```markdown
# usage-collector

Per-machine daemon. Computes Claude Code token totals from `~/.claude/projects/**/*.jsonl`,
reads Claude limit % (`api.anthropic.com/api/oauth/usage`, using Claude Code's own OAuth token),
Codex limit % (`chatgpt.com` usage endpoint, falling back to `~/.codex/sessions` rollout files),
and Copilot premium-request quota (`api.github.com/copilot_internal/user` via `gh auth token`).
Pushes a snapshot to the relay every 30s. Never refreshes vendor tokens (read-only).

## Install on a new machine
1. `git clone` this repo (or copy the `collector/` directory) — Node 22+ required.
2. Create `~/.config/usage-collector/config.json` (chmod 600):
   `{ "relayUrl": "https://usage-relay.<sub>.workers.dev", "pushToken": "<PUSH_TOKEN>" }`
3. Smoke test: `node collector/src/index.js --once --print --no-push`
4. Install the service: `bash collector/install/install.sh`
   (WSL2/headless: also `sudo loginctl enable-linger $USER`)

Sources degrade independently: if Claude Code / Codex / gh isn't present or logged in on a machine,
that section reports null and the freshest other machine wins at the relay.

Logs: `journalctl --user -u usage-collector -f`
```

- [ ] **Step 4: Install and verify on this machine**

Run: `chmod +x collector/install/install.sh && bash collector/install/install.sh`
Expected: service active (running). If `systemctl --user` errors on WSL2 (no user manager), STOP and tell the user to run `sudo loginctl enable-linger $USER` (and if systemd itself is disabled in WSL, document running via `nohup node collector/src/index.js &` as interim), then retry.

Run: `sleep 65 && journalctl --user -u usage-collector -n 20 --no-pager`
Expected: startup line + no repeated errors; at least two push cycles.

- [ ] **Step 5: Verify freshness end-to-end**

Run: `RELAY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/usage-collector/tokens.json')).relayUrl)") && READ=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/usage-collector/tokens.json')).readToken)") && curl -s "$RELAY/v1/summary" -H "Authorization: Bearer $READ" | node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('machines:',JSON.stringify(s.machines));console.log('tokens ageSec:',s.claude.tokens?.ageSec);})"`
Expected: this machine listed with `ageSec` < 60.

- [ ] **Step 6: Commit**

```bash
git add collector/install/ collector/README.md
git commit -m "feat(collector): systemd user service and installer"
```
