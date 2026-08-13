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
