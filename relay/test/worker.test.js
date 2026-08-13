import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value, _opts) { store.set(key, value); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    async get(key) { return store.get(key) ?? null; },
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

test('push requires the push token', async () => {
  const e = env();
  assert.equal((await worker.fetch(push(SNAP, 'wrong'), e)).status, 401);
  assert.equal((await worker.fetch(push(SNAP, 'read-secret'), e)).status, 401, 'read token must not authorize push');
  assert.equal((await worker.fetch(push(SNAP), e)).status, 200);
});

test('push stores snapshot under machine:<id>', async () => {
  const e = env();
  await worker.fetch(push(SNAP), e);
  const stored = JSON.parse(e.USAGE_KV.store.get('machine:wsl-box'));
  assert.equal(stored.machineId, 'wsl-box');
  assert.ok(stored.receivedAt, 'server stamps receivedAt');
});

test('push rejects garbage: bad JSON and missing machineId', async () => {
  const e = env();
  const bad = new Request('https://relay.test/v1/push', { method: 'POST', headers: { authorization: 'Bearer push-secret' }, body: 'not json' });
  assert.equal((await worker.fetch(bad, e)).status, 400);
  assert.equal((await worker.fetch(push({ v: 1 }), e)).status, 400);
});

test('summary requires the read token and merges stored machines', async () => {
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
  const res = await worker.fetch(new Request('https://relay.test/nope'), env());
  assert.equal(res.status, 404);
});
