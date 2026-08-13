import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetListCache, _setClock, persistDecision } from '../src/worker.js';

function fakeKV() {
  const store = new Map();
  const calls = { put: 0, list: 0, get: 0 };
  return {
    store,
    calls,
    async put(key, value, _opts) { calls.put++; store.set(key, value); },
    async list({ prefix }) {
      calls.list++;
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    async get(key) { calls.get++; return store.get(key) ?? null; },
  };
}

const env = () => ({ USAGE_KV: fakeKV(), PUSH_TOKEN: 'push-secret', READ_TOKEN: 'read-secret' });

const push = (body, token = 'push-secret') =>
  new Request('https://relay.test/v1/push', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const summary = (token = 'read-secret') =>
  new Request('https://relay.test/v1/summary', { headers: { authorization: `Bearer ${token}` } });

const SNAP = { v: 1, machineId: 'wsl-box', sentAt: new Date().toISOString(), claude: { limits: null, tokens: null }, codex: { limits: null }, copilot: { quota: null } };

// Every test starts from a clean module-global list cache and the real clock.
const reset = () => { _resetListCache(); _setClock(); };

test('push requires the push token', async () => {
  reset();
  const e = env();
  assert.equal((await worker.fetch(push(SNAP, 'wrong'), e)).status, 401);
  assert.equal((await worker.fetch(push(SNAP, 'read-secret'), e)).status, 401, 'read token must not authorize push');
  assert.equal((await worker.fetch(push(SNAP), e)).status, 200);
});

test('push stores snapshot under machine:<id>', async () => {
  reset();
  const e = env();
  await worker.fetch(push(SNAP), e);
  const stored = JSON.parse(e.USAGE_KV.store.get('machine:wsl-box'));
  assert.equal(stored.machineId, 'wsl-box');
  assert.ok(stored.receivedAt, 'server stamps receivedAt');
});

test('push rejects garbage: bad JSON and missing machineId', async () => {
  reset();
  const e = env();
  const bad = new Request('https://relay.test/v1/push', { method: 'POST', headers: { authorization: 'Bearer push-secret' }, body: 'not json' });
  assert.equal((await worker.fetch(bad, e)).status, 400);
  assert.equal((await worker.fetch(push({ v: 1 }), e)).status, 400);
});

test('summary requires the read token and merges stored machines', async () => {
  reset();
  const e = env();
  await worker.fetch(push(SNAP), e);
  await worker.fetch(push({ ...SNAP, machineId: 'work-pc' }), e);
  assert.equal((await worker.fetch(summary('wrong'), e)).status, 401);
  const res = await worker.fetch(summary(), e);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.v, 1);
  assert.equal(body.machines.length, 2);
});

test('unknown route is 404', async () => {
  reset();
  const res = await worker.fetch(new Request('https://relay.test/nope'), env());
  assert.equal(res.status, 404);
});

// --- B1: auth must fail CLOSED ----------------------------------------------

test('B1: an empty/absent token env never authorizes anything', async () => {
  reset();
  const blank = { USAGE_KV: fakeKV(), PUSH_TOKEN: '', READ_TOKEN: '' };
  const bare = (path, method = 'GET') =>
    new Request(`https://relay.test${path}`, { method, headers: { authorization: 'Bearer ' }, body: method === 'POST' ? JSON.stringify(SNAP) : undefined });
  assert.equal((await worker.fetch(bare('/v1/push', 'POST'), blank)).status, 401, 'empty PUSH_TOKEN + "Bearer " must 401');
  assert.equal((await worker.fetch(bare('/v1/summary'), blank)).status, 401, 'empty READ_TOKEN + "Bearer " must 401');
  assert.equal(blank.USAGE_KV.calls.put, 0, 'nothing was written');

  const missing = { USAGE_KV: fakeKV() }; // secrets not bound at all
  assert.equal((await worker.fetch(push(SNAP, ''), missing)).status, 401);
  assert.equal((await worker.fetch(summary(''), missing)).status, 401);
  assert.equal((await worker.fetch(new Request('https://relay.test/v1/summary'), missing)).status, 401, 'no header at all');
});

test('B1: an empty bearer never matches a real configured token', async () => {
  reset();
  const e = env();
  const emptyAuth = new Request('https://relay.test/v1/summary', { headers: { authorization: 'Bearer ' } });
  assert.equal((await worker.fetch(emptyAuth, e)).status, 401);
  assert.equal((await worker.fetch(new Request('https://relay.test/v1/summary', { headers: { authorization: 'Bearer' } }), e)).status, 401);
});

// --- B5: push validation -----------------------------------------------------

test('B5: push rejects bodies larger than 32KB', async () => {
  reset();
  const e = env();
  const huge = { ...SNAP, junk: 'x'.repeat(33 * 1024) };
  const res = await worker.fetch(push(huge), e);
  assert.equal(res.status, 413);
  assert.equal(e.USAGE_KV.calls.put, 0);
  assert.equal((await worker.fetch(push({ ...SNAP, junk: 'x'.repeat(1024) }), e)).status, 200, 'a normal-sized body still passes');
});

test('B5: machineId must match /^[\\w.-]{1,64}$/', async () => {
  reset();
  const e = env();
  for (const bad of ['has space', 'slash/es', '', 'x'.repeat(65), 'quote"', '../../etc']) {
    assert.equal((await worker.fetch(push({ ...SNAP, machineId: bad }), e)).status, 400, `machineId ${JSON.stringify(bad)} must be rejected`);
  }
  for (const ok of ['wsl-box', 'work_pc.local', 'A1', 'x'.repeat(64)]) {
    assert.equal((await worker.fetch(push({ ...SNAP, machineId: ok }), e)).status, 200, `machineId ${JSON.stringify(ok)} must be accepted`);
  }
  assert.equal((await worker.fetch(push([1, 2, 3]), e)).status, 400, 'arrays are not snapshots');
});

// --- B4a: KV write budget ----------------------------------------------------

const withTokens = (total, computedAt) => ({
  ...SNAP,
  claude: { limits: null, tokens: { computedAt, today: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0, total } } },
});

test('B4: persistDecision — unchanged, tokens-only and value changes', () => {
  const t0 = Date.parse('2026-08-13T16:00:00Z');
  const stored = { ...withTokens(10, 'a'), receivedAt: new Date(t0).toISOString(), sentAt: new Date(t0).toISOString() };

  assert.equal(persistDecision(null, stored, t0).put, true, 'first snapshot always persists');
  assert.equal(persistDecision(stored, { ...stored, sentAt: 'later' }, t0 + 5_000).put, false, 'nothing meaningful changed');
  assert.equal(persistDecision(stored, withTokens(11, 'b'), t0 + 5_000).put, false, 'tokens-only change inside 150s is deferred');
  assert.equal(persistDecision(stored, withTokens(11, 'b'), t0 + 150_000).put, true, 'tokens-only change persists once 150s have passed');
  assert.equal(persistDecision(stored, { ...stored, claude: { ...stored.claude, limits: { fetchedAt: 'z', session: { pct: 5 } } } }, t0 + 5_000).put, true, 'a limits/quota value change always persists');
  assert.equal(persistDecision(stored, { ...stored, sentAt: 'later' }, t0 + 300_000).put, true, 'heartbeat write refreshes age + TTL when nothing changes');
});

test('B4: repeated identical pushes do not write to KV', async () => {
  reset();
  let t = Date.parse('2026-08-13T16:00:00Z');
  _setClock(() => t);
  const e = env();
  assert.equal((await worker.fetch(push(SNAP), e)).status, 200);
  assert.equal(e.USAGE_KV.calls.put, 1);
  const receivedAt = JSON.parse(e.USAGE_KV.store.get('machine:wsl-box')).receivedAt;

  t += 30_000;
  const res = await worker.fetch(push({ ...SNAP, sentAt: new Date(t).toISOString() }), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, skipped: true });
  assert.equal(e.USAGE_KV.calls.put, 1, 'no second write');
  assert.equal(JSON.parse(e.USAGE_KV.store.get('machine:wsl-box')).receivedAt, receivedAt, 'stored entry untouched');

  // ... until the heartbeat window elapses, which refreshes age and the 7-day TTL
  t += 300_000;
  await worker.fetch(push({ ...SNAP, sentAt: new Date(t).toISOString() }), e);
  assert.equal(e.USAGE_KV.calls.put, 2, 'heartbeat write');
});

test('B4: token-only churn is rate limited to one write per 150s', async () => {
  reset();
  let t = Date.parse('2026-08-13T16:00:00Z');
  _setClock(() => t);
  const e = env();
  await worker.fetch(push(withTokens(1, new Date(t).toISOString())), e);
  assert.equal(e.USAGE_KV.calls.put, 1);

  let total = 1;
  for (let i = 0; i < 4; i++) { // four more 30s cycles, tokens moving each time
    t += 30_000; total += 1;
    await worker.fetch(push(withTokens(total, new Date(t).toISOString())), e);
  }
  assert.equal(e.USAGE_KV.calls.put, 1, '120s of token churn cost zero extra writes');

  t += 30_000; total += 1;
  await worker.fetch(push(withTokens(total, new Date(t).toISOString())), e);
  assert.equal(e.USAGE_KV.calls.put, 2, 'the write lands once 150s have elapsed');
  assert.equal(JSON.parse(e.USAGE_KV.store.get('machine:wsl-box')).claude.tokens.today.total, total);
});

test('B4: a limits change is written through immediately', async () => {
  reset();
  let t = Date.parse('2026-08-13T16:00:00Z');
  _setClock(() => t);
  const e = env();
  const base = { ...SNAP, claude: { limits: { fetchedAt: new Date(t).toISOString(), session: { pct: 10, resetsAt: 'R' }, weekly: null, extra: [], extraUsage: null }, tokens: null } };
  await worker.fetch(push(base), e);
  assert.equal(e.USAGE_KV.calls.put, 1);

  t += 5_000;
  const refreshed = { ...base, claude: { ...base.claude, limits: { ...base.claude.limits, fetchedAt: new Date(t).toISOString() } } };
  await worker.fetch(push(refreshed), e);
  assert.equal(e.USAGE_KV.calls.put, 1, 'a fetchedAt-only refresh is not worth a write');

  t += 5_000;
  const moved = { ...base, claude: { ...base.claude, limits: { ...base.claude.limits, fetchedAt: new Date(t).toISOString(), session: { pct: 11, resetsAt: 'R' } } } };
  await worker.fetch(push(moved), e);
  assert.equal(e.USAGE_KV.calls.put, 2, 'a percentage change is written straight through');
  assert.equal(JSON.parse(e.USAGE_KV.store.get('machine:wsl-box')).claude.limits.session.pct, 11);
});

// --- B4b: LIST cache ---------------------------------------------------------

test('B4: KV.list is cached for 300s but per-machine values stay fresh', async () => {
  reset();
  let t = Date.parse('2026-08-13T16:00:00Z');
  _setClock(() => t);
  const e = env();
  await worker.fetch(push({ ...SNAP, machineId: 'a' }), e);

  await worker.fetch(summary(), e);
  assert.equal(e.USAGE_KV.calls.list, 1);
  const getsAfterFirst = e.USAGE_KV.calls.get;

  // a new snapshot for a KNOWN machine must be visible on the very next read
  t += 200_000;
  await worker.fetch(push({ ...SNAP, machineId: 'a', sentAt: new Date(t).toISOString(), claude: { limits: null, tokens: { computedAt: new Date(t).toISOString(), today: { total: 7 } } } }), e);
  const body = await (await worker.fetch(summary(), e)).json();
  assert.equal(e.USAGE_KV.calls.list, 1, 'the key list is served from cache');
  assert.ok(e.USAGE_KV.calls.get > getsAfterFirst, 'but every machine key is re-read');
  assert.equal(body.claude.tokens.today.total, 7, 'fresh values reach the device immediately');

  // a brand-new machine appears once the list cache expires
  await worker.fetch(push({ ...SNAP, machineId: 'b' }), e);
  assert.equal((await (await worker.fetch(summary(), e)).json()).machines.length, 1, 'still one machine inside the cache window');
  t += 300_000;
  const after = await (await worker.fetch(summary(), e)).json();
  assert.equal(e.USAGE_KV.calls.list, 2, 'cache expired -> one more list');
  assert.equal(after.machines.length, 2);
});

test('B4: the list cache is per-KV-namespace-content, not shared across tests', async () => {
  reset();
  const e = env();
  await worker.fetch(push(SNAP), e);
  assert.equal((await (await worker.fetch(summary(), e)).json()).machines.length, 1);
  assert.equal(e.USAGE_KV.calls.list, 1);
});
