import { mergeSnapshots } from './merge.js';

const WEEK_MS = 604800_000;
const MAX_BODY_BYTES = 32 * 1024;               // B5
const MACHINE_ID_RE = /^[\w.-]{1,64}$/;         // B5

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// Test seam: the relay's only clock (shared by the worker and the DO).
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

// --- Storage: one Durable Object holding every machine's latest snapshot ------
// Replaces the KV design whose free-tier budgets (1000 writes/day, 1000 lists/day)
// this relay outgrew: the per-isolate list cache bought far less than designed
// because free-plan isolates are evicted and scattered across POPs, and change-heavy
// days rode the write cap. The DO free tier allows 100k row writes and 5M row reads
// per day, so every push is persisted as-is — no write budget, no list cache, and
// token churn reaches the device on the next poll instead of up to 150s later.
// Single instance: state is a Map hydrated from SQLite-backed storage once per DO
// lifetime; summaries are served from memory.
export class UsageStore {
  #ctx;
  #machines = null;   // Map<machineId, snapshot>
  #loading = null;

  constructor(ctx, _env) { this.#ctx = ctx; }

  async #load() {
    this.#loading ??= this.#ctx.storage.list().then((stored) => { this.#machines = new Map(stored); });
    await this.#loading;
  }

  async fetch(request) {
    await this.#load();
    const url = new URL(request.url);
    const nowMs = clock();

    if (request.method === 'POST' && url.pathname === '/push') {
      const snap = await request.json();  // already validated by the worker in front
      snap.receivedAt = new Date(nowMs).toISOString();
      this.#machines.set(snap.machineId, snap);
      await this.#ctx.storage.put(snap.machineId, snap);
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/summary') {
      // Prune machines silent for over a week (the old KV TTL, made explicit).
      // Every stored snapshot was stamped receivedAt on write, so an unparseable
      // stamp means a corrupt row — prune those too.
      for (const [id, snap] of this.#machines) {
        const receivedMs = Date.parse(snap?.receivedAt ?? '');
        if (!(Number.isFinite(receivedMs) && nowMs - receivedMs <= WEEK_MS)) {
          this.#machines.delete(id);
          await this.#ctx.storage.delete(id);
        }
      }
      return json(mergeSnapshots([...this.#machines.values()], nowMs));
    }

    return json({ error: 'not found' }, 404);
  }
}

// The single store instance. Auth and validation stay out here in the stateless
// worker so junk traffic (workers.dev gets scanned) never invokes the DO.
const store = (env) => env.USAGE_DO.get(env.USAGE_DO.idFromName('v1'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/push') {
      if (!tokenEquals(bearer(request), env.PUSH_TOKEN)) return json({ error: 'unauthorized' }, 401);

      // B5: bound the body before parsing it — one compromised collector must not be
      // able to stuff the store (and every device's parser) with megabytes.
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

      return store(env).fetch(new Request('https://do/push', { method: 'POST', body: JSON.stringify(snap) }));
    }

    if (request.method === 'GET' && url.pathname === '/v1/summary') {
      if (!tokenEquals(bearer(request), env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
      return store(env).fetch(new Request('https://do/summary'));
    }

    return json({ error: 'not found' }, 404);
  },
};
