import { mergeSnapshots } from './merge.js';

const WEEK_SECONDS = 604800;
const MAX_BODY_BYTES = 32 * 1024;               // B5
const MACHINE_ID_RE = /^[\w.-]{1,64}$/;         // B5
const TOKEN_WRITE_MIN_MS = 150_000;             // B4: token-only churn costs at most one write / 150s
const HEARTBEAT_MS = 300_000;                   // B4: refresh age + 7-day TTL when nothing changed
const LIST_CACHE_MS = 300_000;                  // B4: KV list() is capped at 1000/day on the free plan

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// Test seam: the worker's only clock.
let clock = () => Date.now();
export function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

function bearer(request) {
  const h = request.headers.get('authorization') ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  return token.length > 0 ? token : null;   // B1: "Bearer " (empty token) is not a credential
}

// Constant-time-ish comparison; tokens are long random strings.
// B1: fails CLOSED — an unbound/empty secret or an empty presented token never matches,
// so a missing `wrangler secret` cannot make the relay world-readable/writable.
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- B4: KV write budget -----------------------------------------------------
// Free plan: 1000 writes/day and 1000 list/day. The shipped cadences (push every
// 30s, device poll every 20s) would spend 2880 writes + 4320 lists per day, so the
// relay self-DoSes mid-afternoon. Both are fixed here: writes are skipped when they
// would not change what the device renders, and the key list is cached per isolate.

// Deterministic deep-equal by canonical stringification (key order independent).
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

// Drop the timestamps that move on every cycle without changing what is displayed.
function stripStamps(v) {
  if (Array.isArray(v)) return v.map(stripStamps);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'sentAt' || k === 'receivedAt' || k === 'fetchedAt' || k === 'computedAt') continue;
      out[k] = stripStamps(val);
    }
    return out;
  }
  return v;
}

const vendorValues = (snap) => {
  const s = snap !== null && typeof snap === 'object' ? { ...snap } : {};
  const claude = s.claude !== null && typeof s.claude === 'object' ? { ...s.claude } : {};
  delete claude.tokens;
  s.claude = claude;
  return canon(stripStamps(s));
};
const tokenValues = (snap) => canon(stripStamps(snap?.claude?.tokens ?? null));

export function persistDecision(stored, incoming, nowMs) {
  if (!stored) return { put: true, reason: 'new-machine' };
  const storedAt = Date.parse(stored.receivedAt ?? stored.sentAt ?? '');
  const ageMs = Number.isNaN(storedAt) ? Infinity : nowMs - storedAt;

  // Vendor limits/quota/extraUsage values changed: write straight through so the
  // percentages keep their spec §2 F8 latency (~5 min end to end).
  if (vendorValues(stored) !== vendorValues(incoming)) return { put: true, reason: 'values-changed' };

  // Token counters move on nearly every 30s cycle; one write per 150s is plenty.
  if (tokenValues(stored) !== tokenValues(incoming)) {
    return ageMs >= TOKEN_WRITE_MIN_MS
      ? { put: true, reason: 'tokens-changed' }
      : { put: false, reason: 'tokens-rate-limited' };
  }

  // Nothing changed: an occasional heartbeat keeps machines[].ageSec honest and
  // refreshes the 7-day KV TTL.
  return ageMs >= HEARTBEAT_MS ? { put: true, reason: 'heartbeat' } : { put: false, reason: 'unchanged' };
}

let listCache = { keys: null, at: 0 };
export function _resetListCache() { listCache = { keys: null, at: 0 }; }

async function machineKeys(env, nowMs) {
  if (listCache.keys && nowMs - listCache.at < LIST_CACHE_MS) return listCache.keys;
  const { keys } = await env.USAGE_KV.list({ prefix: 'machine:' });
  listCache = { keys: keys.map((k) => k.name), at: nowMs };
  return listCache.keys;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const nowMs = clock();

    if (request.method === 'POST' && url.pathname === '/v1/push') {
      if (!tokenEquals(bearer(request), env.PUSH_TOKEN)) return json({ error: 'unauthorized' }, 401);

      // B5: bound the body before parsing it — one compromised collector must not be
      // able to stuff KV (and every device's parser) with megabytes.
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
      let raw;
      try { raw = await request.text(); } catch { return json({ error: 'invalid body' }, 400); }
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);

      let snap;
      try { snap = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
      if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return json({ error: 'invalid snapshot' }, 400);
      if (typeof snap.machineId !== 'string' || !MACHINE_ID_RE.test(snap.machineId)) {
        return json({ error: 'machineId required' }, 400);
      }

      const key = `machine:${snap.machineId}`;
      let stored = null;
      try {
        const prev = await env.USAGE_KV.get(key);
        if (prev) stored = JSON.parse(prev);
      } catch { stored = null; } // unreadable/corrupt previous value: just overwrite it

      const decision = persistDecision(stored, snap, nowMs);
      if (!decision.put) return json({ ok: true, skipped: true });

      snap.receivedAt = new Date(nowMs).toISOString();
      await env.USAGE_KV.put(key, JSON.stringify(snap), { expirationTtl: WEEK_SECONDS });
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/v1/summary') {
      if (!tokenEquals(bearer(request), env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const names = await machineKeys(env, nowMs);
      const snapshots = [];
      for (const name of names) {
        const raw = await env.USAGE_KV.get(name); // values are always read fresh; only the key list is cached
        if (!raw) continue;
        try { snapshots.push(JSON.parse(raw)); } catch { /* skip corrupt entries */ }
      }
      return json(mergeSnapshots(snapshots, nowMs));
    }

    return json({ error: 'not found' }, 404);
  },
};
