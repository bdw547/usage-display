import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function toIso(resetsAt) {
  if (resetsAt == null) return null;
  if (typeof resetsAt === 'number') return new Date(resetsAt * 1000).toISOString(); // epoch seconds
  return String(resetsAt);
}

export function normalizeCodexRateLimits(rl, fetchedAt) {
  const out = { fetchedAt, fiveHour: null, weekly: null, plan: rl?.plan_type ?? null };
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || w.used_percent == null) continue;
    const win = { pct: w.used_percent, resetsAt: toIso(w.resets_at) };
    if ((w.window_minutes ?? 0) <= 600) out.fiveHour = win;
    else out.weekly = win;
  }
  return out;
}

// Scan the newest rollout file(s) for the last token_count line carrying rate_limits.
export function latestRolloutRateLimits(sessionsDir) {
  let files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(sessionsDir);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const f of files.slice(0, 5)) {
    let lines;
    try { lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const j = JSON.parse(lines[i]);
        const rl = j?.payload?.rate_limits;
        if (rl) return { rateLimits: rl, fetchedAt: j.timestamp ?? null };
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

export async function fetchCodexLimits({ home = homedir(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  // 1) Try the live endpoint with the CLI's current token (never refresh it ourselves).
  try {
    const auth = JSON.parse(readFileSync(join(home, '.codex/auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    if (token) {
      const res = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
        headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': account ?? '', 'user-agent': 'codex_cli_rs' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = await res.json();
        const rl = body?.rate_limits ?? body?.rateLimits ?? body;
        if (rl && (rl.primary || rl.secondary)) {
          return normalizeCodexRateLimits(rl, new Date(now()).toISOString());
        }
      }
    }
  } catch { /* fall through to rollout files */ }

  // 2) Fallback: last known values from the newest session rollout file.
  const hit = latestRolloutRateLimits(join(home, '.codex/sessions'));
  if (hit) return normalizeCodexRateLimits(hit.rateLimits, hit.fetchedAt);
  return null;
}
