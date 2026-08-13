import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function normalizeCopilotUser(body, fetchedAt) {
  const q = body?.quota_snapshots?.premium_interactions;
  if (!q) return null;
  const unlimited = q.unlimited === true;
  return {
    fetchedAt,
    used: q.credits_used ?? null,
    included: unlimited ? null : q.entitlement ?? null,
    pctUsed: unlimited ? 0 : Math.round((100 - (q.percent_remaining ?? 100)) * 10) / 10,
    resetsAt: body.quota_reset_date_utc ?? (body.quota_reset_date ? `${body.quota_reset_date}T00:00:00.000Z` : null),
    plan: body.copilot_plan ?? null,
  };
}

function discoverToken({ home, execImpl }) {
  try {
    const t = execImpl('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    if (t) return t;
  } catch { /* gh not installed or not logged in */ }
  try {
    const apps = JSON.parse(readFileSync(join(home, '.config/github-copilot/apps.json'), 'utf8'));
    for (const v of Object.values(apps)) if (v?.oauth_token) return v.oauth_token;
  } catch { /* no copilot config */ }
  return null;
}

export async function fetchCopilotQuota({ home = homedir(), fetchImpl = fetch, now = () => Date.now(), execImpl = execFileSync } = {}) {
  const token = discoverToken({ home, execImpl });
  if (!token) return null;
  let res;
  try {
    res = await fetchImpl('https://api.github.com/copilot_internal/user', {
      headers: { authorization: `token ${token}`, 'user-agent': 'GitHubCopilotChat/0.26', 'editor-version': 'vscode/1.99.0' },
      signal: AbortSignal.timeout(15000),
    });
  } catch { return null; }
  if (!res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  return normalizeCopilotUser(body, new Date(now()).toISOString());
}
