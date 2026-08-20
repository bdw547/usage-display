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
    // B2: the relay stamps receivedAt on every push (worker.js). Ages are now computed
    // from it, so fixtures must carry it. Transit is ~0 here, so receivedAt == sentAt.
    receivedAt: iso(10),
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

// A machine whose clock is off by skewMs. Every timestamp the COLLECTOR mints moves
// (sentAt, fetchedAt, computedAt); receivedAt is stamped by the relay and resetsAt comes
// straight from the vendor payloads, so neither of those moves.
function skewed(machineId, skewMs) {
  const shift = (isoStr) => new Date(Date.parse(isoStr) + skewMs).toISOString();
  const s = snap(machineId);
  s.sentAt = shift(s.sentAt);
  s.claude.limits.fetchedAt = shift(s.claude.limits.fetchedAt);
  s.claude.tokens.computedAt = shift(s.claude.tokens.computedAt);
  s.codex.limits.fetchedAt = shift(s.codex.limits.fetchedAt);
  s.copilot.quota.fetchedAt = shift(s.copilot.quota.fetchedAt);
  return s;
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
  assert.equal(s.claude.limits.ageSec, 5);
  assert.equal(s.claude.tokens.today.total, 1354, 'today totals sum across machines');
  assert.equal(s.claude.tokens.today.in, 101);
  assert.equal(s.claude.tokens.costUsd.month, 14);
  assert.equal(s.claude.tokens.ageSec, 30, 'tokens age is the OLDEST contributor so staleness is honest');
  assert.equal(s.machines.length, 2);
});

test('null sections tolerated and omitted machines still counted', () => {
  const bare = { v: 1, machineId: 'm3', sentAt: iso(20), receivedAt: iso(20), claude: { limits: null, tokens: null }, codex: { limits: null }, copilot: { quota: null } };
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

// --- B2: clock-skew immunity -------------------------------------------------

test('B2: a machine 1h fast and a machine 1h slow produce the identical summary', () => {
  const base = mergeSnapshots([snap('m1')], NOW);
  const fast = mergeSnapshots([skewed('m1', 3600_000)], NOW);
  const slow = mergeSnapshots([skewed('m1', -3600_000)], NOW);
  assert.deepEqual(fast, base, 'a +1h clock changes nothing in the summary');
  assert.deepEqual(slow, base, 'a -1h clock changes nothing in the summary');
  // and the ages are the true ones, not the skewed ones
  assert.equal(fast.claude.limits.ageSec, 60);
  assert.equal(fast.claude.tokens.ageSec, 30);
  assert.equal(fast.copilot.quota.ageSec, 300);
  assert.equal(fast.machines[0].ageSec, 10);
});

test('B2: a fast clock can no longer hijack freshest-wins', () => {
  const drifty = snap('drifty');
  drifty.claude.limits.session.pct = 99;
  // Truly fetched 2h ago, but this box runs 1h fast so the ISO reads 1h in the FUTURE.
  drifty.claude.limits.fetchedAt = new Date(NOW - 7200_000 + 3600_000).toISOString();
  drifty.sentAt = new Date(NOW - 10_000 + 3600_000).toISOString();
  drifty.receivedAt = iso(10);
  const s = mergeSnapshots([drifty, snap('honest')], NOW);
  assert.equal(s.claude.limits.session.pct, 13, 'the honest 60s-old machine wins');
  assert.equal(s.claude.limits.ageSec, 60);
  // and the drifty machine's own age is reported as its real 2h, never negative
  const only = mergeSnapshots([drifty], NOW);
  assert.equal(only.claude.limits.ageSec, 7200);
});

test('B2: ages never go negative even when everything is stamped in the future', () => {
  const future = snap('future');
  future.receivedAt = new Date(NOW + 60_000).toISOString(); // relay clock cannot really do this; clamp anyway
  const s = mergeSnapshots([future], NOW);
  assert.equal(s.machines[0].ageSec, 0);
  assert.ok(s.claude.limits.ageSec >= 0);
});

test('B2: legacy snapshots without receivedAt still merge (best-effort ages)', () => {
  const legacy = snap('legacy');
  delete legacy.receivedAt;
  const s = mergeSnapshots([legacy], NOW);
  assert.equal(s.machines[0].ageSec, 10);
  assert.equal(s.claude.limits.ageSec, 60);
});

// --- B3: dead machines must not pollute the summed token windows -------------

test('B3: a machine whose tokens are >24h old is excluded from the sums but still listed', () => {
  const live = snap('live');
  const dead = snap('dead');
  dead.sentAt = iso(47 * 3600);
  dead.receivedAt = iso(47 * 3600);
  dead.claude.tokens.computedAt = iso(48 * 3600); // 48h old -> excluded
  const s = mergeSnapshots([live, dead], NOW);
  assert.equal(s.claude.tokens.today.total, 1350, 'only the live machine contributes');
  assert.equal(s.claude.tokens.costUsd.month, 12.5);
  assert.equal(s.claude.tokens.ageSec, 30, 'age is the oldest INCLUDED contributor');
  assert.equal(s.machines.length, 2, 'machines[] still lists the dead box');
  assert.ok(s.machines.some((m) => m.id === 'dead' && m.ageSec > 24 * 3600));
});

test('B3: a machine just under the 24h cutoff still contributes', () => {
  const live = snap('live');
  const old = snap('old');
  old.sentAt = iso(23 * 3600);
  old.receivedAt = iso(23 * 3600);
  old.claude.tokens.computedAt = iso(23 * 3600);
  const s = mergeSnapshots([live, old], NOW);
  assert.equal(s.claude.tokens.today.total, 2700, 'both machines sum');
  assert.equal(s.claude.tokens.ageSec, 23 * 3600);
});

test('B3: when every contributor is stale the tokens section is null, not stale garbage', () => {
  const dead = snap('dead');
  dead.sentAt = iso(47 * 3600);
  dead.receivedAt = iso(47 * 3600);
  dead.claude.tokens.computedAt = iso(48 * 3600);
  const s = mergeSnapshots([dead], NOW);
  assert.equal(s.claude.tokens, null);
  assert.equal(s.machines.length, 1);
  assert.ok(s.claude.limits, 'limits are still served (freshest-wins has no cutoff)');
});

// --- B5: robustness ----------------------------------------------------------

test('B5: a snapshot whose sections throw is skipped, never fatal', () => {
  const boom = snap('boom');
  Object.defineProperty(boom.claude, 'limits', { get() { throw new Error('boom'); }, enumerable: true });
  Object.defineProperty(boom.codex, 'limits', { get() { throw new Error('boom'); }, enumerable: true });
  const s = mergeSnapshots([boom, snap('m1')], NOW);
  assert.equal(s.claude.limits.session.pct, 13, 'the healthy machine still serves limits');
  assert.equal(s.codex.limits.weekly.pct, 27);
  assert.equal(s.machines.length, 2);
});

test('B5: garbage-shaped sections are filtered instead of winning freshest-wins', () => {
  const junk = {
    machineId: 'junk',
    sentAt: 'not-a-date',
    receivedAt: iso(1),
    claude: { limits: { fetchedAt: iso(1), session: 'nope', weekly: 42, extra: 'not-an-array' }, tokens: { computedAt: iso(1), today: 'nope' } },
    codex: { limits: { fetchedAt: iso(1) } },
    copilot: { quota: { fetchedAt: iso(1) } },
  };
  const s = mergeSnapshots([junk, snap('m1')], NOW);
  assert.equal(s.claude.limits.session.pct, 13, 'usable data beats fresher garbage');
  assert.equal(s.codex.limits.fiveHour.pct, 10);
  assert.equal(s.copilot.quota.used, 9459);
  assert.equal(s.claude.tokens.today.total, 1350, 'garbage buckets add nothing');
  assert.equal(s.machines.length, 2);
});

test('B5: totally malformed entries (null, string, number) do not throw', () => {
  const s = mergeSnapshots([null, 'string', 42, [], snap('m1')], NOW);
  assert.equal(s.claude.limits.session.pct, 13);
  assert.equal(s.machines.length, 5, 'every stored machine is still accounted for');
});
