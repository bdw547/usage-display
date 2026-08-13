import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function scopeLabel(l) {
  if (typeof l.scope === 'string' && l.scope) return l.scope;
  const dn = l.scope?.model?.display_name;
  if (typeof dn === 'string' && dn) return dn.toLowerCase();
  return String(l.kind ?? 'other').replace(/^weekly_/, '');
}

export function normalizeAnthropicUsage(body, fetchedAt) {
  const out = { fetchedAt, session: null, weekly: null, extra: [] };
  if (Array.isArray(body?.limits) && body.limits.length > 0) {
    for (const l of body.limits) {
      if (l?.percent == null) continue;
      const w = { pct: l.percent, resetsAt: l.resets_at ?? null };
      if (l.kind === 'session') out.session = w;
      else if (l.kind === 'weekly_all') out.weekly = w;
      else out.extra.push({ label: scopeLabel(l), ...w });
    }
  }
  out.extraUsage = body?.extra_usage
    ? { usedCreditsUsd: Math.round(((body.extra_usage.used_credits ?? 0) / Math.pow(10, body.extra_usage.decimal_places ?? 2)) * 100) / 100 }
    : null;
  if (!out.session && body?.five_hour?.utilization != null) {
    out.session = { pct: body.five_hour.utilization, resetsAt: body.five_hour.resets_at ?? null };
  }
  if (!out.weekly && body?.seven_day?.utilization != null) {
    out.weekly = { pct: body.seven_day.utilization, resetsAt: body.seven_day.resets_at ?? null };
  }
  return out;
}

let nextAllowedAt = 0; // module-level backoff; this endpoint 429s aggressive pollers

export async function fetchClaudeLimits({ home = homedir(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (now() < nextAllowedAt) return null;
  let creds;
  try { creds = JSON.parse(readFileSync(join(home, '.claude/.credentials.json'), 'utf8')); } catch { return null; }
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && oauth.expiresAt < now()) return null; // stale token: Claude Code refreshes it on next use

  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    });
  } catch { return null; }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    nextAllowedAt = now() + Math.max(retryAfter, 300) * 1000;
    return null;
  }
  if (!res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  return normalizeAnthropicUsage(body, new Date(now()).toISOString());
}
