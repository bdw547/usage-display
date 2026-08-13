import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots, relSeconds } from '../src/merge.js';

const NOW = Date.parse('2026-08-13T16:00:00Z');
const iso = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();

function snap(machineId, over = {}) {
  return {
    v: 1,
    machineId,
    sentAt: iso(10),
    claude: {
      limits: {
        fetchedAt: iso(60),
        session: { pct: 13, resetsAt: '2026-08-13T19:30:00Z' },
        weekly: { pct: 51, resetsAt: '2026-08-16T09:00:00Z' },
        extra: [],
        extraUsage: { usedCreditsUsd: 12.34 },
      },
      tokens: {
        computedAt: iso(30),
        today: { in: 100, out: 50, cacheRead: 1000, cacheWrite: 200, total: 1350 },
        week: { in: 700, out: 350, cacheRead: 7000, cacheWrite: 1400, total: 9450 },
        month: { in: 3000, out: 1500, cacheRead: 30000, cacheWrite: 6000, total: 40500 },
        allTime: { in: 9000, out: 4500, cacheRead: 90000, cacheWrite: 18000, total: 121500 },
        costUsd: { month: 12.5, allTime: 99.25 },
      },
    },
    codex: { limits: { fetchedAt: iso(120), fiveHour: { pct: 10, resetsAt: '2026-08-13T18:00:00Z' }, weekly: { pct: 27, resetsAt: '2026-08-16T00:00:00Z' }, plan: 'plus' } },
    copilot: { quota: { fetchedAt: iso(300), used: 9459, included: 30000, pctUsed: 31.6, resetsAt: '2026-09-01T00:00:00Z', plan: 'business' } },
    ...over,
  };
}

test('relSeconds converts ISO to relative seconds from now', () => {
  assert.equal(relSeconds(iso(90), NOW), -90);           // 90s in the past
  assert.equal(relSeconds('2026-08-13T16:05:00Z', NOW), 300); // 5m in the future
  assert.equal(relSeconds(null, NOW), null);
  assert.equal(relSeconds('garbage', NOW), null);
});

test('single machine: summary carries ageSec and resetsInSec, no ISO leaves', () => {
  const s = mergeSnapshots([snap('m1')], NOW);
  assert.equal(s.v, 1);
  assert.deepEqual(s.machines, [{ id: 'm1', ageSec: 10 }]);
  assert.equal(s.claude.limits.ageSec, 60);
  assert.equal(s.claude.limits.session.pct, 13);
  assert.equal(s.claude.limits.session.resetsInSec, relSeconds('2026-08-13T19:30:00Z', NOW));
  assert.equal(s.claude.limits.extraUsage.usedCreditsUsd, 12.34);
  assert.equal(s.claude.tokens.ageSec, 30);
  assert.equal(s.claude.tokens.today.total, 1350);
  assert.equal(s.codex.limits.weekly.pct, 27);
  assert.equal(s.copilot.quota.used, 9459);
  assert.ok(!JSON.stringify(s).includes('2026-08-16T09:00:00Z'), 'no raw ISO reset strings in summary');
});

test('two machines: tokens sum, freshest limits win', () => {
  const older = snap('m1');
  const newer = snap('m2');
  newer.claude.limits.fetchedAt = iso(5);
  newer.claude.limits.session.pct = 44;
  newer.claude.tokens.today = { in: 1, out: 1, cacheRead: 1, cacheWrite: 1, total: 4 };
  newer.claude.tokens.costUsd = { month: 1.5, allTime: 2.0 };
  const s = mergeSnapshots([older, newer], NOW);
  assert.equal(s.claude.limits.session.pct, 44, 'freshest machine limits win');
  assert.equal(s.claude.tokens.today.total, 1354, 'today totals sum across machines');
  assert.equal(s.claude.tokens.today.in, 101);
  assert.equal(s.claude.tokens.costUsd.month, 14);
  assert.equal(s.claude.tokens.ageSec, 30, 'tokens age is the OLDEST contributor so staleness is honest');
  assert.equal(s.machines.length, 2);
});

test('null sections tolerated and omitted machines still counted', () => {
  const bare = { v: 1, machineId: 'm3', sentAt: iso(20), claude: { limits: null, tokens: null }, codex: { limits: null }, copilot: { quota: null } };
  const s = mergeSnapshots([bare], NOW);
  assert.equal(s.claude.limits, null);
  assert.equal(s.claude.tokens, null);
  assert.equal(s.codex.limits, null);
  assert.equal(s.copilot.quota, null);
  assert.deepEqual(s.machines, [{ id: 'm3', ageSec: 20 }]);
});

test('empty input produces empty-but-valid summary', () => {
  const s = mergeSnapshots([], NOW);
  assert.equal(s.v, 1);
  assert.deepEqual(s.machines, []);
  assert.equal(s.claude.limits, null);
});
