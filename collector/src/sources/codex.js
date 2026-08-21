import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function toIso(resetsAt) {
  if (resetsAt == null) return null;
  if (typeof resetsAt === 'number') return new Date(resetsAt * 1000).toISOString(); // epoch seconds
  return String(resetsAt);
}

// Two shapes reach this function and both are live:
//   live endpoint : { primary_window, secondary_window } with limit_window_seconds + reset_at
//   rollout files : { primary, secondary }               with window_minutes + resets_at
// The endpoint renamed every one of these fields at some point, which silently broke the
// live path and left the device showing stale rollout data, so accept both spellings.
const hasRateLimitShape = (rl) =>
  !!rl && typeof rl === 'object' &&
  ('primary' in rl || 'secondary' in rl || 'primary_window' in rl || 'secondary_window' in rl);

// Window length in minutes; unknown counts as short (the pre-existing rule).
function windowMinutes(w) {
  if (w.window_minutes != null) return w.window_minutes;
  if (w.limit_window_seconds != null) return w.limit_window_seconds / 60;
  return 0;
}

// Pull the rate-limit object out of a usage response, whichever shape it arrived in,
// and lift plan_type up from wherever it lives. Returns null if nothing matches.
export function pickRateLimits(body) {
  if (!body || typeof body !== 'object') return null;
  for (const candidate of [body.rate_limit, body.rate_limits, body.rateLimits, body]) {
    if (hasRateLimitShape(candidate)) {
      return { ...candidate, plan_type: candidate.plan_type ?? body.plan_type ?? null };
    }
  }
  return null;
}

export function normalizeCodexRateLimits(rl, fetchedAt) {
  const out = { fetchedAt, fiveHour: null, weekly: null, plan: rl?.plan_type ?? null };
  for (const w of [rl?.primary ?? rl?.primary_window, rl?.secondary ?? rl?.secondary_window]) {
    if (!w || w.used_percent == null) continue;
    const win = { pct: w.used_percent, resetsAt: toIso(w.resets_at ?? w.reset_at) };
    if (windowMinutes(w) <= 600) out.fiveHour = win;
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
        // B8: some rollout lines carry no (or an unparseable) timestamp. Emitting
        // fetchedAt:null made the relay drop the whole codex section, so fall back
        // to the file's mtime — the last time Codex wrote to this session.
        if (rl) return { rateLimits: rl, fetchedAt: usableStamp(j.timestamp) ?? fileMtimeIso(f) };
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

function usableStamp(ts) {
  return typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? ts : null;
}

function fileMtimeIso(path) {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; }
}

export async function fetchCodexLimits({ home = homedir(), fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
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
        const rl = pickRateLimits(body);
        if (rl) return normalizeCodexRateLimits(rl, new Date(now()).toISOString());
        // Do not let a renamed field decay quietly into the rollout fallback again.
        log(`usage endpoint returned an unrecognized shape (top-level keys: ${Object.keys(body ?? {}).join(', ') || 'none'}); using rollout files`);
      } else {
        log(`usage endpoint returned HTTP ${res.status}; using rollout files`);
      }
    }
  } catch { /* fall through to rollout files */ }

  // 2) Fallback: last known values from the newest session rollout file.
  const hit = latestRolloutRateLimits(join(home, '.codex/sessions'));
  // Without a fetchedAt the relay cannot age the section, so it would discard it (B8).
  if (hit && hit.fetchedAt) return normalizeCodexRateLimits(hit.rateLimits, hit.fetchedAt);
  return null;
}
