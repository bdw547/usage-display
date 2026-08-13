// Pure merge logic — no Workers APIs so it unit-tests in plain Node.

export function relSeconds(isoString, nowMs) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return null;
  return Math.round((t - nowMs) / 1000);
}

const age = (isoString, nowMs) => {
  const r = relSeconds(isoString, nowMs);
  return r === null ? null : -r;
};

// {pct, resetsAt} -> {pct, resetsInSec}
function relWindow(w, nowMs) {
  if (!w) return null;
  return { pct: w.pct ?? null, resetsInSec: relSeconds(w.resetsAt, nowMs) };
}

function freshest(snapshots, pick) {
  let best = null;
  let bestT = -Infinity;
  for (const s of snapshots) {
    const sec = pick(s);
    if (!sec || !sec.fetchedAt) continue;
    const t = Date.parse(sec.fetchedAt);
    if (!Number.isNaN(t) && t > bestT) { bestT = t; best = sec; }
  }
  return best;
}

const ZERO = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addBucket(acc, b) {
  if (!b) return acc;
  acc.in += b.in ?? 0;
  acc.out += b.out ?? 0;
  acc.cacheRead += b.cacheRead ?? 0;
  acc.cacheWrite += b.cacheWrite ?? 0;
  acc.total += b.total ?? 0;
  return acc;
}

export function mergeSnapshots(snapshots, nowMs) {
  const machines = snapshots.map((s) => ({ id: s.machineId ?? 'unknown', ageSec: age(s.sentAt, nowMs) ?? 0 }));

  // --- Claude limits / Codex limits / Copilot quota: freshest machine wins ---
  const cl = freshest(snapshots, (s) => s.claude?.limits);
  const claudeLimits = cl
    ? {
        ageSec: age(cl.fetchedAt, nowMs),
        session: relWindow(cl.session, nowMs),
        weekly: relWindow(cl.weekly, nowMs),
        extra: (cl.extra ?? []).map((e) => ({ label: e.label, ...relWindow(e, nowMs) })),
        extraUsage: cl.extraUsage ?? null,
      }
    : null;

  const cx = freshest(snapshots, (s) => s.codex?.limits);
  const codexLimits = cx
    ? { ageSec: age(cx.fetchedAt, nowMs), fiveHour: relWindow(cx.fiveHour, nowMs), weekly: relWindow(cx.weekly, nowMs), plan: cx.plan ?? null }
    : null;

  const cp = freshest(snapshots, (s) => s.copilot?.quota);
  const copilotQuota = cp
    ? { ageSec: age(cp.fetchedAt, nowMs), used: cp.used ?? null, included: cp.included ?? null, pctUsed: cp.pctUsed ?? null, resetsInSec: relSeconds(cp.resetsAt, nowMs), plan: cp.plan ?? null }
    : null;

  // --- Claude tokens: sum across machines; age = oldest contributor ---
  const tokenSecs = snapshots.map((s) => s.claude?.tokens).filter(Boolean);
  let claudeTokens = null;
  if (tokenSecs.length > 0) {
    claudeTokens = {
      ageSec: Math.max(...tokenSecs.map((t) => age(t.computedAt, nowMs) ?? 0)),
      today: ZERO(), week: ZERO(), month: ZERO(), allTime: ZERO(),
      costUsd: { month: 0, allTime: 0 },
    };
    for (const t of tokenSecs) {
      addBucket(claudeTokens.today, t.today);
      addBucket(claudeTokens.week, t.week);
      addBucket(claudeTokens.month, t.month);
      addBucket(claudeTokens.allTime, t.allTime);
      claudeTokens.costUsd.month += t.costUsd?.month ?? 0;
      claudeTokens.costUsd.allTime += t.costUsd?.allTime ?? 0;
    }
    claudeTokens.costUsd.month = Math.round(claudeTokens.costUsd.month * 100) / 100;
    claudeTokens.costUsd.allTime = Math.round(claudeTokens.costUsd.allTime * 100) / 100;
  }

  return {
    v: 1,
    serverTime: new Date(nowMs).toISOString(),
    machines,
    claude: { limits: claudeLimits, tokens: claudeTokens },
    codex: { limits: codexLimits },
    copilot: { quota: copilotQuota },
  };
}
