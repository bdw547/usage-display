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
