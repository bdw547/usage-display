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
  assert.deepEqual(n.extra.map((e) => e.label), ['opus', 'fable']);
  assert.equal(n.extra[0].pct, 30);
  assert.equal(n.extra[1].pct, 62);
  for (const e of n.extra) assert.equal(typeof e.label, 'string');
  assert.equal(n.extraUsage.usedCreditsUsd, 12.34);
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
  assert.equal(n.extraUsage, null);
});
