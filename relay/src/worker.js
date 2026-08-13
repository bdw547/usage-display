import { mergeSnapshots } from './merge.js';

const WEEK_SECONDS = 604800;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function bearer(request) {
  const h = request.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Constant-time-ish comparison; tokens are long random strings.
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/push') {
      if (!tokenEquals(bearer(request), env.PUSH_TOKEN)) return json({ error: 'unauthorized' }, 401);
      let snap;
      try { snap = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      if (!snap || typeof snap.machineId !== 'string' || !snap.machineId) return json({ error: 'machineId required' }, 400);
      snap.receivedAt = new Date().toISOString();
      await env.USAGE_KV.put(`machine:${snap.machineId}`, JSON.stringify(snap), { expirationTtl: WEEK_SECONDS });
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/v1/summary') {
      if (!tokenEquals(bearer(request), env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const { keys } = await env.USAGE_KV.list({ prefix: 'machine:' });
      const snapshots = [];
      for (const { name } of keys) {
        const raw = await env.USAGE_KV.get(name);
        if (!raw) continue;
        try { snapshots.push(JSON.parse(raw)); } catch { /* skip corrupt entries */ }
      }
      return json(mergeSnapshots(snapshots, Date.now()));
    }

    return json({ error: 'not found' }, 404);
  },
};
