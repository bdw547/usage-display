import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { UsageStore, _setClock } from '../src/worker.js';

// Fake of the Durable Object storage KV API (SQLite-backed in production).
function fakeStorage() {
  const map = new Map();
  const calls = { put: 0, get: 0, list: 0, delete: 0 };
  return {
    map,
    calls,
    async put(key, value) { calls.put++; map.set(key, structuredClone(value)); },
    async get(key) { calls.get++; return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async list() { calls.list++; return new Map([...map.entries()].map(([k, v]) => [k, structuredClone(v)])); },
    async delete(key) { calls.delete++; return map.delete(key); },
  };
}

// Fake of the USAGE_DO namespace binding: one UsageStore instance per name,
// sharing `storage` so tests can inspect persistence and simulate eviction.
function fakeNamespace(storage) {
  const instances = new Map();
  return {
    instances,
    idFromName(name) { return name; },
    get(id) {
      if (!instances.has(id)) instances.set(id, new UsageStore({ storage }, {}));
      const stub = instances.get(id);
      return { fetch: (req) => stub.fetch(req) };
    },
    // Simulate a DO eviction/restart: next get() builds a fresh instance over the same storage.
    evict() { instances.clear(); },
  };
}

function env() {
  const storage = fakeStorage();
  return { USAGE_DO: fakeNamespace(storage), PUSH_TOKEN: 'push-secret', READ_TOKEN: 'read-secret', _storage: storage };
}

const push = (body, token = 'push-secret') =>
  new Request('https://relay.test/v1/push', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const summary = (token = 'read-secret') =>
  new Request('https://relay.test/v1/summary', { headers: { authorization: `Bearer ${token}` } });

const SNAP = { v: 1, machineId: 'wsl-box', sentAt: new Date().toISOString(), claude: { limits: null, tokens: null }, codex: { limits: null }, copilot: { quota: null } };

const reset = () => _setClock();

test('push requires the push token', async () => {
  reset();
  const e = env();
  assert.equal((await worker.fetch(push(SNAP, 'wrong'), e)).status, 401);
  assert.equal((await worker.fetch(push(SNAP, 'read-secret'), e)).status, 401, 'read token must not authorize push');
  assert.equal((await worker.fetch(push(SNAP), e)).status, 200);
});

test('push stores the snapshot in DO storage and stamps receivedAt', async () => {
  reset();
  const e = env();
  await worker.fetch(push(SNAP), e);
  const stored = e._storage.map.get('wsl-box');
  assert.equal(stored.machineId, 'wsl-box');
  assert.ok(stored.receivedAt, 'server stamps receivedAt');
});

test('push rejects garbage without invoking the DO: bad JSON and missing machineId', async () => {
  reset();
  const e = env();
  assert.equal((await worker.fetch(push('not json'), e)).status, 400);
  assert.equal((await worker.fetch(push({ v: 1 }), e)).status, 400);
  assert.equal(e._storage.calls.put, 0, 'nothing was written');
  assert.equal(e.USAGE_DO.instances.size, 0, 'the DO was never instantiated for invalid input');
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
  const e = env();
  const blank = { ...e, PUSH_TOKEN: '', READ_TOKEN: '' };
  const bare = (path, method = 'GET') =>
    new Request(`https://relay.test${path}`, { method, headers: { authorization: 'Bearer ' }, body: method === 'POST' ? JSON.stringify(SNAP) : undefined });
  assert.equal((await worker.fetch(bare('/v1/push', 'POST'), blank)).status, 401, 'empty PUSH_TOKEN + "Bearer " must 401');
  assert.equal((await worker.fetch(bare('/v1/summary'), blank)).status, 401, 'empty READ_TOKEN + "Bearer " must 401');
  assert.equal(e._storage.calls.put, 0, 'nothing was written');

  const missing = { USAGE_DO: e.USAGE_DO }; // secrets not bound at all
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

// --- B5: push validation ------------------------------------------------------

test('B5: push rejects bodies larger than 32KB', async () => {
  reset();
  const e = env();
  const huge = { ...SNAP, junk: 'x'.repeat(33 * 1024) };
  const res = await worker.fetch(push(huge), e);
  assert.equal(res.status, 413);
  assert.equal(e._storage.calls.put, 0);
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

test('B5: a corrupt stored snapshot never 500s the summary', async () => {
  reset();
  const e = env();
  await worker.fetch(push(SNAP), e);
  e._storage.map.set('evil', { machineId: { not: 'a string' }, claude: 42 });
  e.USAGE_DO.evict(); // force a re-hydration that includes the corrupt entry
  const res = await worker.fetch(summary(), e);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).machines.some((m) => m.id === 'wsl-box'));
});

// --- DO storage semantics -------------------------------------------------------

test('DO: fresh values reach the device on the very next poll (no write deferral)', async () => {
  reset();
  let t = Date.parse('2026-08-20T16:00:00Z');
  _setClock(() => t);
  const e = env();
  await worker.fetch(push({ ...SNAP, claude: { limits: null, tokens: { computedAt: new Date(t).toISOString(), today: { total: 1 } } } }), e);

  t += 30_000; // one collector cycle later — under KV this write was deferred up to 150s
  await worker.fetch(push({ ...SNAP, sentAt: new Date(t).toISOString(), claude: { limits: null, tokens: { computedAt: new Date(t).toISOString(), today: { total: 7 } } } }), e);
  const body = await (await worker.fetch(summary(), e)).json();
  assert.equal(body.claude.tokens.today.total, 7, 'token churn is visible immediately');
});

test('DO: a brand-new machine appears on the very next summary (no list cache)', async () => {
  reset();
  const e = env();
  await worker.fetch(push({ ...SNAP, machineId: 'a' }), e);
  await worker.fetch(summary(), e);
  await worker.fetch(push({ ...SNAP, machineId: 'b' }), e);
  const body = await (await worker.fetch(summary(), e)).json();
  assert.equal(body.machines.length, 2);
});

test('DO: state survives eviction — a fresh instance re-hydrates from storage', async () => {
  reset();
  const e = env();
  await worker.fetch(push({ ...SNAP, machineId: 'a' }), e);
  await worker.fetch(push({ ...SNAP, machineId: 'b' }), e);
  e.USAGE_DO.evict();
  const listsBefore = e._storage.calls.list;
  const body = await (await worker.fetch(summary(), e)).json();
  assert.equal(body.machines.length, 2, 'machines came back from storage');
  assert.equal(e._storage.calls.list, listsBefore + 1, 'one list() to hydrate the new instance');
  await worker.fetch(summary(), e);
  assert.equal(e._storage.calls.list, listsBefore + 1, 'later requests are served from memory');
});

test('DO: machines silent for over 7 days are pruned from summary and storage', async () => {
  reset();
  let t = Date.parse('2026-08-20T16:00:00Z');
  _setClock(() => t);
  const e = env();
  await worker.fetch(push({ ...SNAP, machineId: 'old' }), e);
  t += 8 * 24 * 3600 * 1000;
  await worker.fetch(push({ ...SNAP, machineId: 'fresh', sentAt: new Date(t).toISOString() }), e);
  const body = await (await worker.fetch(summary(), e)).json();
  assert.deepEqual(body.machines.map((m) => m.id), ['fresh'], 'the 8-day-old machine is gone');
  assert.equal(e._storage.map.has('old'), false, 'and its row was deleted');
});
