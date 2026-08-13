import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.js';

// B6: state now carries `cache` (last-good vendor sections) so a restart republishes
// real numbers instead of nulls, hence the extra key in these shape assertions.
const EMPTY = { files: {}, days: {}, seen: {}, cache: { claudeLimits: null, codexLimits: null, copilotQuota: null } };

test('round-trips state and tolerates missing/corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  const empty = loadState(p);
  assert.deepEqual(empty, EMPTY);
  empty.days['2026-08-13'] = { 'claude-fable-5': { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, cw5m: 4, cw1h: 0 } };
  saveState(p, empty);
  const back = loadState(p);
  assert.equal(back.days['2026-08-13']['claude-fable-5'].out, 2);
});

test('corrupt state file falls back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  writeFileSync(p, '{not valid json');
  assert.deepEqual(loadState(p), EMPTY);
});

test('B6: the vendor cache round-trips so a restart does not publish nulls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  const s = loadState(p);
  s.cache.claudeLimits = { fetchedAt: '2026-08-13T16:00:00.000Z', session: { pct: 13, resetsAt: 'R' }, weekly: null, extra: [], extraUsage: null };
  s.cache.codexLimits = { fetchedAt: '2026-08-13T15:58:00.000Z', fiveHour: { pct: 4, resetsAt: 'R' }, weekly: null, plan: 'plus' };
  s.cache.copilotQuota = { fetchedAt: '2026-08-13T15:50:00.000Z', used: 12, included: 300, pctUsed: 4, resetsAt: 'R', plan: 'business' };
  saveState(p, s);

  const back = loadState(p);
  assert.equal(back.cache.claudeLimits.session.pct, 13);
  assert.equal(back.cache.codexLimits.plan, 'plus');
  assert.equal(back.cache.copilotQuota.used, 12);
  assert.equal(back.cache.claudeLimits.fetchedAt, '2026-08-13T16:00:00.000Z', 'fetchedAt survives so the relay still ages it honestly');
});

test('B6: a pre-B6 state file (no cache key) still loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  writeFileSync(p, JSON.stringify({ files: { a: 1 }, days: {}, seen: {} }));
  const s = loadState(p);
  assert.deepEqual(s.cache, EMPTY.cache);
  assert.equal(s.files.a, 1);
});
