// Pure merge logic — no Workers APIs so it unit-tests in plain Node.

// B3: a machine that stopped reporting must not keep inflating the summed token
// windows (especially "today") for the whole 7-day retention window.
const TOKENS_MAX_AGE_SEC = 24 * 3600;

export function relSeconds(isoString, nowMs) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return null;
  return Math.round((t - nowMs) / 1000);
}

const msOf = (iso) => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// --- B2: skew-free ages ------------------------------------------------------
// Every timestamp a collector mints (sentAt, fetchedAt, computedAt) lives on the
// COLLECTOR's clock; receivedAt (stamped by the worker on push) and nowMs live on
// the relay's clock. The old code subtracted one from the other, so a collector
// whose clock drifts (WSL2 after suspend/resume) reported negative ages and won
// freshest-wins forever. We only ever subtract two timestamps taken from the SAME
// clock, so the skew cancels exactly:
//
//   ageSec = (nowMs - receivedAt)   [relay clock: how long we have held it]
//          + (sentAt - stampedAt)   [collector clock: how old it was when pushed]
//
// resetsAt is NOT collector-minted — all three sources copy it verbatim from the
// vendor payload (claude-limits.js `l.resets_at`, codex.js `resets_at` epoch,
// copilot.js `quota_reset_date_utc`), i.e. it is true absolute wall-clock time.
// So reset countdowns stay anchored to the relay clock (`relSeconds(..., nowMs)`),
// which is already skew-free; re-anchoring them to fetchedAt would have *added*
// the collector's clock error back into the countdown.
export function sectionAgeSec(snapshot, stampIso, nowMs) {
  const stamp = msOf(stampIso);
  if (stamp === null) return null;
  const received = msOf(snapshot?.receivedAt);
  if (received === null) return Math.max(0, Math.round((nowMs - stamp) / 1000)); // pre-B2 snapshot: best effort
  const sent = msOf(snapshot?.sentAt);
  const ageAtPushMs = sent === null ? 0 : sent - stamp;
  return Math.max(0, Math.round((nowMs - received + ageAtPushMs) / 1000));
}

export function machineAgeSec(snapshot, nowMs) {
  const received = msOf(snapshot?.receivedAt) ?? msOf(snapshot?.sentAt);
  if (received === null) return 0;
  return Math.max(0, Math.round((nowMs - received) / 1000));
}

// {pct, resetsAt} -> {pct, resetsInSec}
function relWindow(w, nowMs) {
  if (!isObj(w)) return null;
  return { pct: num(w.pct), resetsInSec: relSeconds(w.resetsAt, nowMs) };
}

// Shape every machine's section, keep the ones that survived and carry usable data,
// then let the freshest (smallest skew-free age) win. Shaping per machine inside a
// try/catch is B5: one malformed stored snapshot must never 500 the whole summary.
function freshestSection(snapshots, nowMs, pick, shape, usable) {
  let best = null;
  for (const s of snapshots) {
    try {
      const sec = pick(s);
      if (!isObj(sec)) continue;
      const ageSec = sectionAgeSec(s, sec.fetchedAt, nowMs);
      if (ageSec === null) continue;
      const value = shape(sec, ageSec, nowMs);
      if (!usable(value)) continue;
      if (best === null || ageSec < best.ageSec) best = { ageSec, value };
    } catch { /* B5: skip the malformed machine, never fail the merge */ }
  }
  return best === null ? null : best.value;
}

const ZERO = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addBucket(acc, b) {
  if (!isObj(b)) return acc;
  acc.in += num(b.in) ?? 0;
  acc.out += num(b.out) ?? 0;
  acc.cacheRead += num(b.cacheRead) ?? 0;
  acc.cacheWrite += num(b.cacheWrite) ?? 0;
  acc.total += num(b.total) ?? 0;
  return acc;
}

export function mergeSnapshots(snapshots, nowMs) {
  const list = Array.isArray(snapshots) ? snapshots : [];

  const machines = list.map((s) => {
    try {
      const id = typeof s?.machineId === 'string' && s.machineId ? s.machineId : 'unknown';
      return { id, ageSec: machineAgeSec(s, nowMs) };
    } catch {
      return { id: 'unknown', ageSec: 0 };
    }
  });

  // --- Claude limits / Codex limits / Copilot quota: freshest machine wins ---
  const claudeLimits = freshestSection(
    list, nowMs,
    (s) => s?.claude?.limits,
    (cl, ageSec, now) => ({
      ageSec,
      session: relWindow(cl.session, now),
      weekly: relWindow(cl.weekly, now),
      extra: Array.isArray(cl.extra)
        ? cl.extra.filter(isObj).map((e) => ({ label: typeof e.label === 'string' ? e.label : 'other', ...relWindow(e, now) }))
        : [],
      extraUsage: isObj(cl.extraUsage) ? cl.extraUsage : null,
    }),
    (v) => v.session !== null || v.weekly !== null || v.extra.length > 0 || v.extraUsage !== null,
  );

  const codexLimits = freshestSection(
    list, nowMs,
    (s) => s?.codex?.limits,
    (cx, ageSec, now) => ({
      ageSec,
      fiveHour: relWindow(cx.fiveHour, now),
      weekly: relWindow(cx.weekly, now),
      plan: typeof cx.plan === 'string' ? cx.plan : null,
    }),
    (v) => v.fiveHour !== null || v.weekly !== null,
  );

  const copilotQuota = freshestSection(
    list, nowMs,
    (s) => s?.copilot?.quota,
    (cp, ageSec, now) => ({
      ageSec,
      used: num(cp.used),
      included: num(cp.included),
      pctUsed: num(cp.pctUsed),
      resetsInSec: relSeconds(cp.resetsAt, now),
      plan: typeof cp.plan === 'string' ? cp.plan : null,
    }),
    (v) => v.used !== null || v.pctUsed !== null,
  );

  // --- Claude tokens: sum across machines; age = oldest INCLUDED contributor ---
  const contributors = [];
  for (const s of list) {
    try {
      const t = s?.claude?.tokens;
      if (!isObj(t)) continue;
      const ageSec = sectionAgeSec(s, t.computedAt, nowMs);
      if (ageSec === null || ageSec > TOKENS_MAX_AGE_SEC) continue; // B3: dead machine, drop from the sums
      contributors.push({ t, ageSec });
    } catch { /* B5 */ }
  }

  let claudeTokens = null;
  if (contributors.length > 0) {
    claudeTokens = {
      ageSec: Math.max(...contributors.map((c) => c.ageSec)),
      today: ZERO(), week: ZERO(), month: ZERO(), allTime: ZERO(),
      costUsd: { month: 0, allTime: 0 },
    };
    for (const { t } of contributors) {
      try {
        addBucket(claudeTokens.today, t.today);
        addBucket(claudeTokens.week, t.week);
        addBucket(claudeTokens.month, t.month);
        addBucket(claudeTokens.allTime, t.allTime);
        claudeTokens.costUsd.month += num(t.costUsd?.month) ?? 0;
        claudeTokens.costUsd.allTime += num(t.costUsd?.allTime) ?? 0;
      } catch { /* B5 */ }
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
