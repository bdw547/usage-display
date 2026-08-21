# Collector Write Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the collector rewriting its entire 1.43 MB state file every cycle, so the 30s cadence costs far less disk churn and a future 5s cadence stays affordable.

**Architecture:** Three independent changes to the collector daemon. `scanClaudeTokens` starts reporting whether it actually changed anything, so the caller can skip no-op writes. A new pure `shouldSave` policy throttles the remaining writes to at most one per 60s. The dedupe-key retention window shrinks from 30 days to 7, which cuts each write to roughly a quarter of its current size. The relay and firmware are untouched.

**Tech Stack:** Node.js 22 (zero dependencies), `node --test`, ES modules.

**Spec:** No separate spec document — this is a bounded change whose design was agreed in the 2026-08-20 session and is restated in full under Global Constraints and each task's rationale.

## Global Constraints

- Zero runtime dependencies. The collector is a zero-dependency daemon; do not add packages.
- ES modules only (`"type": "module"`), Node 22 built-ins only.
- Run the whole collector suite with `cd collector && npm test` — every task must leave it green.
- Never print or commit the contents of `~/.config/usage-collector/tokens.json`.
- Crash-safety invariant: byte offsets (`state.files`), dedupe keys (`state.seen`) and day totals (`state.days`) are written together in one atomic `saveState`. Never split them across separate writes — replaying transcript lines is safe only because all three advance together.
- Preserve B6: the vendor `cache` must still survive a restart so the display does not republish nulls.
- Measured baseline to improve on: `state.json` is 1.43 MB, of which `seen` is 1.40 MB (18,656 keys); the daemon writes it every 30s unconditionally (~172 MB/hour, ~4 GB/day).

---

### Task 1: `scanClaudeTokens` reports whether state changed

**Files:**
- Modify: `collector/src/sources/claude-tokens.js:74-85`
- Test: `collector/test/claude-tokens.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `scanClaudeTokens(state, opts) -> boolean` — `true` when the scan advanced a file offset, ingested a new record, or pruned an expired dedupe key; `false` when the call left `state` byte-for-byte identical. Task 3 consumes this return value.

- [ ] **Step 1: Write the failing tests**

Add to `collector/test/claude-tokens.test.js`:

```javascript
test('scan reports whether it changed state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-proj-'));
  cpSync(FIXTURES, dir, { recursive: true });
  const state = freshState();

  assert.equal(scanClaudeTokens(state, { projectsDir: dir, now: NOW }), true, 'first scan ingests records');
  assert.equal(scanClaudeTokens(state, { projectsDir: dir, now: NOW }), false, 'second scan with no new lines changes nothing');

  const f = join(dir, 'proj-a', 'session-1.jsonl');
  appendFileSync(f, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-13T18:00:00Z',
    requestId: 'req_new',
    message: { id: 'msg_new', model: 'claude-fable-5', usage: { input_tokens: 5, output_tokens: 6 } },
  }) + '\n');
  assert.equal(scanClaudeTokens(state, { projectsDir: dir, now: NOW }), true, 'an appended line is a change');
});

test('scan reports a change when it prunes an expired dedupe key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-proj-'));
  const state = freshState();
  state.seen['stale:key'] = '2026-01-01';
  assert.equal(scanClaudeTokens(state, { projectsDir: dir, now: NOW }), true, 'pruning mutates state');
  assert.equal(state.seen['stale:key'], undefined, 'and the key is gone');
  assert.equal(scanClaudeTokens(state, { projectsDir: dir, now: NOW }), false, 'nothing left to prune');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd collector && node --test test/claude-tokens.test.js`
Expected: FAIL — `scanClaudeTokens` currently returns `undefined`, so the first assertion reports `undefined !== true`.

- [ ] **Step 3: Implement the change signal**

In `collector/src/sources/claude-tokens.js`, make `ingestLine` report whether it counted a record. Change its final `return` path: the two early `return` statements for unparseable lines, non-assistant lines, missing usage/model, and the `state.seen[key]` duplicate check all become `return false`; the end of the function returns `true`.

Then rewrite `scanClaudeTokens` (currently lines 74-85):

```javascript
export function scanClaudeTokens(state, { projectsDir, now = new Date() } = {}) {
  let changed = false;
  for (const path of jsonlFiles(projectsDir)) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const known = state.files[path] !== undefined;
    const rec = (state.files[path] ??= { offset: 0 });
    if (!known) changed = true;                     // a newly tracked file is new state
    if (st.size < rec.offset) { rec.offset = 0; changed = true; } // truncated/rotated: rescan
    if (st.size > rec.offset) {
      const next = readNewLines(state, path, rec.offset, st.size);
      if (next !== rec.offset) { rec.offset = next; changed = true; }
    }
  }
  // Prune dedupe keys older than SEEN_RETENTION_DAYS to bound state size.
  const cutoff = localDay(new Date(now.getTime() - SEEN_RETENTION_DAYS * 86400e3));
  for (const [k, day] of Object.entries(state.seen)) {
    if (day < cutoff) { delete state.seen[k]; changed = true; }
  }
  return changed;
}
```

Note `readNewLines` already returns the unchanged offset when there is no complete line yet, so comparing against `rec.offset` is the correct "did we consume anything" test. `SEEN_RETENTION_DAYS` does not exist yet — add it as a module constant next to the other top-level constants with the current value so this task changes no behavior:

```javascript
const SEEN_RETENTION_DAYS = 30;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS — the two new tests plus every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add collector/src/sources/claude-tokens.js collector/test/claude-tokens.test.js
git commit -m "feat(collector): scanClaudeTokens reports whether it changed state"
```

---

### Task 2: `shouldSave` throttle policy

**Files:**
- Create: `collector/src/persist.js`
- Test: `collector/test/persist.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `shouldSave({ dirty, lastSaveMs, nowMs, minIntervalMs }) -> boolean`. Task 3 consumes this.

- [ ] **Step 1: Write the failing test**

Create `collector/test/persist.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSave } from '../src/persist.js';

const MIN = 60_000;

test('a clean cycle never writes, however long it has been', () => {
  assert.equal(shouldSave({ dirty: false, lastSaveMs: 0, nowMs: 10 * MIN, minIntervalMs: MIN }), false);
});

test('the first dirty cycle writes immediately', () => {
  assert.equal(shouldSave({ dirty: true, lastSaveMs: 0, nowMs: 1_000, minIntervalMs: MIN }), true);
});

test('a dirty cycle inside the window defers', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs + 59_999, minIntervalMs: MIN }), false);
});

test('a dirty cycle writes once the window has elapsed', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs + MIN, minIntervalMs: MIN }), true);
});

test('a backwards clock step does not wedge the throttle shut', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs - 5 * MIN, minIntervalMs: MIN }), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd collector && node --test test/persist.test.js`
Expected: FAIL — `Cannot find module '.../src/persist.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `collector/src/persist.js`:

```javascript
// The state file is rewritten whole (~1.4MB) on every save, so saving every cycle
// costs ~4GB/day of disk writes to persist a few new byte offsets. Two rules cut
// that: never write a cycle that changed nothing, and write at most once per
// minIntervalMs when it did. Losing up to minIntervalMs of progress to a crash is
// safe — offsets, dedupe keys and day totals are saved together atomically, so the
// next start replays those transcript lines and the dedupe map drops the repeats.
export function shouldSave({ dirty, lastSaveMs, nowMs, minIntervalMs }) {
  if (!dirty) return false;
  const sinceMs = nowMs - lastSaveMs;
  if (sinceMs < 0) return true;   // clock stepped backwards: write rather than wedge shut
  return sinceMs >= minIntervalMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd collector && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add collector/src/persist.js collector/test/persist.test.js
git commit -m "feat(collector): add shouldSave write-throttle policy"
```

---

### Task 3: Wire the throttle into the daemon loop

**Files:**
- Modify: `collector/src/index.js:56-104`

**Interfaces:**
- Consumes: `scanClaudeTokens(...) -> boolean` (Task 1), `shouldSave({...}) -> boolean` (Task 2).
- Produces: no new exports. The daemon now has exactly one in-loop save site.

This task has no unit test: `index.js` is the daemon's top-level loop with no export surface, and the logic it composes is already covered by Tasks 1 and 2. Verification is the `--once` smoke run in Step 3.

- [ ] **Step 1: Add the import and constant**

In `collector/src/index.js`, add to the imports:

```javascript
import { shouldSave } from './persist.js';
```

and next to `PUSH_EVERY_MS` (line 25):

```javascript
const SAVE_MIN_INTERVAL_MS = 60_000;   // at most one 1.4MB state write per minute
```

- [ ] **Step 2: Replace the three in-loop save sites with one throttled site**

Declare the tracking variables next to `let stopping = false;` (line 50):

```javascript
  let dirty = false;
  let lastSaveMs = 0;
```

In the token-scan block, capture the change signal and drop the unconditional `saveState` (currently line 63):

```javascript
    // 1) Local token scan (cheap; every cycle)
    try {
      if (scanClaudeTokens(state, { projectsDir: PROJECTS_DIR })) dirty = true;
      cache.claudeTokens = tokenWindows(state, {});
    } catch (err) {
      log('token scan failed:', err.message);
    }
```

In the vendor-poll block, replace the `if (cacheChanged) { ... }` body (currently lines 88-91) with:

```javascript
    if (cacheChanged) {
      persistCache(); // B6: survive a restart
      dirty = true;
    }
```

Then add the single save site immediately after that block, before the snapshot is assembled:

```javascript
    if (shouldSave({ dirty, lastSaveMs, nowMs: Date.now(), minIntervalMs: SAVE_MIN_INTERVAL_MS })) {
      try {
        saveState(STATE_PATH, state);
        lastSaveMs = Date.now();
        dirty = false;
      } catch (err) {
        log('state save failed:', err.message);   // stays dirty; retried next cycle
      }
    }
```

Leave the post-loop `persistCache(); saveState(STATE_PATH, state);` (lines 106-107) exactly as it is — a clean SIGTERM must always flush, throttle or not.

- [ ] **Step 3: Smoke-test a single cycle without pushing**

Run: `cd collector && node src/index.js --once --no-push --print | head -20`
Expected: a snapshot JSON on stdout and no `state save failed` line. Then confirm the file was written and is still valid:

```bash
node -e "const s=require('fs').readFileSync(process.env.HOME+'/.local/share/usage-collector/state.json','utf8');const j=JSON.parse(s);console.log('ok',Object.keys(j),Object.keys(j.seen).length)"
```

Expected: `ok [ 'files', 'days', 'seen', 'cache' ] <a positive number>`.

- [ ] **Step 4: Run the full suite**

Run: `cd collector && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add collector/src/index.js
git commit -m "perf(collector): write state at most once per minute, and only when it changed"
```

---

### Task 4: Shorten dedupe retention from 30 days to 7

**Files:**
- Modify: `collector/src/sources/claude-tokens.js` (the `SEEN_RETENTION_DAYS` constant added in Task 1)
- Test: `collector/test/claude-tokens.test.js`

**Interfaces:**
- Consumes: `SEEN_RETENTION_DAYS` (Task 1).
- Produces: nothing new.

**Trade-off this task accepts — read before implementing.** `state.seen` exists so that a transcript file which shrinks (truncated or rotated) can be rescanned from offset 0 without double-counting into `state.days`. Shrinking the window from 30 days to 7 means a rescan of a file containing records older than 7 days would re-count those records, permanently inflating the all-time total. In practice Claude Code session files are UUID-named, append-only, and `cleanupPeriodDays=3650` keeps them from being deleted, so a shrink is rare — and 30 days was never a guarantee either, since a long-lived session file can span more than 30 days. The win is real: `seen` is 1.40 MB of the 1.43 MB file, so this cuts every write to roughly a quarter. If that trade reads badly later, changing the constant back is a one-line revert.

- [ ] **Step 1: Write the failing test**

Add to `collector/test/claude-tokens.test.js`:

```javascript
test('dedupe keys are pruned after 7 days, not 30', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-proj-'));
  const state = freshState();
  const dayAgo = (n) => {
    const d = new Date(NOW.getTime() - n * 86400e3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  state.seen['keep:me'] = dayAgo(6);
  state.seen['drop:me'] = dayAgo(8);

  scanClaudeTokens(state, { projectsDir: dir, now: NOW });

  assert.equal(state.seen['keep:me'], dayAgo(6), 'a 6-day-old key is still inside the window');
  assert.equal(state.seen['drop:me'], undefined, 'an 8-day-old key is pruned');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd collector && node --test test/claude-tokens.test.js`
Expected: FAIL — with the window still at 30 days the 8-day-old key survives, so the second assertion reports the date string instead of `undefined`.

- [ ] **Step 3: Change the constant**

In `collector/src/sources/claude-tokens.js`:

```javascript
// 7 days, not 30: `seen` is ~98% of the state file, and every save rewrites the file
// whole. The window only has to cover a transcript file shrinking (truncate/rotate)
// and being rescanned from offset 0 — rare for UUID-named append-only session files.
const SEEN_RETENTION_DAYS = 7;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd collector && npm test`
Expected: PASS.

- [ ] **Step 5: Verify the real state file actually shrinks**

Run one live cycle and measure:

```bash
cd collector && ls -l ~/.local/share/usage-collector/state.json && node src/index.js --once --no-push >/dev/null && ls -l ~/.local/share/usage-collector/state.json
```

Expected: the second size is roughly a quarter of the first (from ~1.43 MB toward ~0.35 MB). Record the actual before/after numbers in the commit message.

- [ ] **Step 6: Commit**

```bash
git add collector/src/sources/claude-tokens.js collector/test/claude-tokens.test.js
git commit -m "perf(collector): prune dedupe keys after 7 days instead of 30"
```

---

### Task 5: Restart the service and confirm the write rate dropped

**Files:**
- Modify: `collector/README.md` (the cadence/state description, if it states the old behavior)

- [ ] **Step 1: Install the new code and restart**

```bash
systemctl --user restart usage-collector.service
systemctl --user status usage-collector.service --no-pager | head -12
```

Expected: `active (running)`, no `state save failed` lines.

- [ ] **Step 2: Confirm writes are actually throttled**

Watch the state file's mtime over three minutes; it must change at most once per minute, not twice per minute:

```bash
for i in $(seq 1 9); do stat -c '%y %s' ~/.local/share/usage-collector/state.json; sleep 20; done
```

Expected: at most 3 distinct timestamps across the 9 samples (and fewer if the machine is idle).

- [ ] **Step 3: Confirm the display still updates**

```bash
curl -s "$(node -e "console.log(require(require('os').homedir()+'/.config/usage-collector/tokens.json').relayUrl)")/v1/summary" \
  -H "Authorization: Bearer $(node -e "console.log(require(require('os').homedir()+'/.config/usage-collector/tokens.json').readToken)")" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('machines',j.machines,'tokens today',j.claude.tokens?.today?.total)})"
```

Expected: this machine's `ageSec` is under 60 and the token total is non-zero. A machine age that keeps climbing past ~120s means pushes stopped — investigate before committing.

- [ ] **Step 4: Update the README if it documents the old behavior**

Read `collector/README.md`. If it states that state is written every cycle, correct it to: state is written at most once per minute and only when the scan changed something; a clean shutdown always flushes.

- [ ] **Step 5: Commit**

```bash
git add collector/README.md
git commit -m "docs(collector): describe the throttled state-write behavior"
```

---

## Self-Review

**Spec coverage.** The three agreed changes each have a task: skip-when-unchanged is Tasks 1 and 3, the 60s throttle is Tasks 2 and 3, the retention cut is Task 4. Task 5 covers deployment and the empirical check that the write rate actually fell, which is the whole point of the change.

**Placeholder scan.** No TBDs. Every code step carries real code; every run step carries a real command and its expected output.

**Type consistency.** `scanClaudeTokens` returns `boolean` in Task 1 and is consumed as a boolean in Task 3. `shouldSave` takes `{ dirty, lastSaveMs, nowMs, minIntervalMs }` in Task 2 and is called with exactly those four keys in Task 3. `SEEN_RETENTION_DAYS` is introduced in Task 1 at value 30 and changed in Task 4 to 7, so Task 1 is behavior-neutral and Task 4 is a one-line diff.

**Ordering note.** Task 1 must land before Task 4, because Task 4 only changes the constant Task 1 introduces. Tasks 1 and 2 are independent of each other and can be done in either order.
