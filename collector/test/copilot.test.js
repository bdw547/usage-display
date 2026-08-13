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
