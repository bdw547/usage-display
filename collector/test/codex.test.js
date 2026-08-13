import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCodexRateLimits, latestRolloutRateLimits, fetchCodexLimits } from '../src/sources/codex.js';

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

// --- B8: a rollout line with no usable timestamp must not poison fetchedAt ----
// fetchedAt:null made the relay discard the whole codex section as if the machine
// had never reported Codex at all.

const MTIME = new Date('2026-08-10T09:15:00.000Z');

function rolloutDir(line) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-'));
  const f = join(dir, 'rollout-2026-08-10T09-00-00-abcdef.jsonl');
  writeFileSync(f, `${line}\n`);
  utimesSync(f, MTIME, MTIME);
  return dir;
}

const RL = { primary: { used_percent: 5, window_minutes: 300, resets_at: 1786000000 }, secondary: null, plan_type: 'plus' };

test('B8: a rollout line without a timestamp falls back to the file mtime', () => {
  const dir = rolloutDir(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: RL } }));
  const hit = latestRolloutRateLimits(dir);
  assert.ok(hit, 'the line is still used');
  assert.equal(hit.fetchedAt, MTIME.toISOString(), 'mtime stands in for the missing timestamp');
  assert.equal(hit.rateLimits.primary.used_percent, 5);
});

test('B8: an unparseable timestamp also falls back to the file mtime', () => {
  const dir = rolloutDir(JSON.stringify({ timestamp: 'not-a-date', payload: { rate_limits: RL } }));
  assert.equal(latestRolloutRateLimits(dir).fetchedAt, MTIME.toISOString());
});

test('B8: the rollout fallback yields a section the relay will actually keep', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  mkdirSync(join(home, '.codex/sessions'), { recursive: true });
  const f = join(home, '.codex/sessions/rollout-2026-08-10T09-00-00-abcdef.jsonl');
  writeFileSync(f, `${JSON.stringify({ payload: { rate_limits: RL } })}\n`);
  utimesSync(f, MTIME, MTIME);
  const out = await fetchCodexLimits({ home, fetchImpl: async () => { throw new Error('offline'); } });
  assert.ok(out, 'section produced');
  assert.equal(out.fetchedAt, MTIME.toISOString());
  assert.equal(out.fiveHour.pct, 5);
});
