# AI Usage Display — Design

**Date:** 2026-08-13
**Status:** Approved pending user review
**Hardware:** Guition ESP32-4848S040C_I (4.0" 480×480 IPS touch, ESP32-S3)

## 1. Purpose

A desk display that shows, live, how much of Ben's AI subscriptions are used:
Claude (Claude Code), Codex (Codex CLI), and GitHub Copilot — plus Claude token
totals. The device travels between home and work, joins whichever known WiFi is
in range automatically, and always shows current data regardless of location.

## 2. Requirements

### Functional
- **F1** Screen: Claude limit usage — 5-hour session % and weekly % (per-model weekly
  where present), with reset countdowns.
- **F2** Screen: Codex limit usage — 5-hour % and weekly %, with resets.
- **F3** Screen: Copilot premium-request usage — used / included, % bar, monthly reset date.
- **F4** Screen: Claude tokens — headline **today**, plus this week (rolling 7d),
  this calendar month, all-time, and estimated cost. Token counts are summed
  across all reporting machines.
- **F5** Screen: Settings/WiFi — current connection (SSID, signal, IP), saved
  networks (list / forget), add network via scan + on-screen touch keyboard,
  relay status and data age.
- **F6** Navigation: swipe left/right between screens (no auto-cycle). Page dots.
- **F7** WiFi: remembers up to 8 networks in flash; on boot connects to the
  strongest known network; auto-reconnects and rescans in background on drop.
  First boot (no saved networks) lands on the WiFi setup flow.
- **F8** Data freshness: token figures within ~90s of activity; vendor limit
  percentages within ~5 minutes. Status bar on every screen shows WiFi strength,
  freshness dot (green <90s / amber <5m / red older), and clock. Revised end-to-end
  latency targets after the KV write-budget work: see the F8 addendum in §6.3.

### Non-functional
- **N1** Never blank on failure: keep last-known data with a "stale Xm" badge.
- **N2** Device holds no vendor credentials and never performs vendor OAuth —
  it only talks to our relay with a device read token.
- **N3** Collector must not interfere with CLI logins (read tokens, never refresh).
- **N4** Cloud costs: fit Cloudflare free tier. Worker requests and KV reads are far
  from their caps; the binding constraints are KV **writes and list ops (1,000/day
  each)**, which the relay manages explicitly — see §6.3.
- **N5** UI stays responsive at all times (no blocking network calls on the UI thread).

### Explicit user decisions
- Usage happens on **multiple machines**; this WSL2 box is the first collector host.
- Topology: **cloud relay** (Cloudflare Worker + KV), collectors push, device polls.
- Token windows shown: today (headline), week, month, all-time + est. cost.
- Navigation: **swipe only**.
- WiFi credential entry: **on-screen keyboard** (no captive portal).
- Firmware approach: **custom C++ — PlatformIO + Arduino core 3.x + LVGL 9 + Arduino_GFX**.

## 3. Architecture

```
[machine 1..N]                      [Cloudflare]                    [ESP32 display]
usage-collector ──POST /v1/push──▶  Worker + KV   ◀──GET /v1/summary── firmware
  every 30s        (per-machine       merge at read     every 20s       5 LVGL pages
                    snapshot, 7d TTL)  tokens: sum
                                       limits: freshest
```

Three deliverables in one repo:

```
usage-display/
├── collector/    Node.js daemon (no heavy deps; Node 22)
├── relay/        Cloudflare Worker (wrangler)
├── firmware/     PlatformIO project (ESP32-S3)
└── docs/
```

## 4. Collector (Node.js daemon)

One process per machine, systemd user service on Linux/WSL2 (installers for
other OSes are docs-only in v1). Config at `~/.config/usage-collector/config.json`:
`{ relayUrl, pushToken, machineId (default: hostname), sources: {claude, codex, copilot} }`.
State cache at `~/.local/share/usage-collector/state.json`.

### Sources

| Source | Method | Cadence |
|---|---|---|
| Claude tokens | Incremental scan of `~/.claude/projects/**/*.jsonl`: track per-file offsets, parse only appended lines, dedupe by `message.id` + `requestId`, sum input/output/cache-create/cache-read per local-tz day. Derive today / rolling-7d / calendar-month / all-time. Cost = static per-model API price table (JSON in repo), labeled estimate. | 30s (mtime check; cheap) |
| Claude limits | `GET https://api.anthropic.com/api/oauth/usage` with bearer from `~/.claude/.credentials.json` + `anthropic-beta: oauth-2025-04-20`. Returns 5h/7d (+ per-model, overage) utilization & resets. On 401: mark stale (Claude Code will refresh its own token on next use). On 429: honor `retry-after`, exponential backoff, min 5-min interval. | 5 min |
| Codex limits | `GET https://chatgpt.com/backend-api/wham/usage` (fallback path: `/backend-api/codex/usage`) with access token + account id from `~/.codex/auth.json`. Fallback on failure: parse newest `~/.codex/sessions/**/rollout-*.jsonl` `token_count.rate_limits` snapshot (same numbers, no network). Field names verified at implementation against live responses; both paths behind one normalizer. | 5 min |
| Copilot quota | Primary: `GET https://api.github.com/copilot_internal/user` (what VS Code uses) with the Copilot/gh OAuth token from `~/.config/github-copilot/apps.json` (fallback: `gh auth token`) → `quota_snapshots.premium_interactions` {entitlement, remaining, percent_remaining, reset date}. Fallback: enhanced-billing user endpoint (only covers personally-paid plans). | 10 min |

### Push

Every 30s, POST the merged per-machine snapshot (schema §6) to the relay with
`Authorization: Bearer <pushToken>`. Vendor poll results are cached between
their slower cycles; a source that errors keeps its last value plus an
`error`/`fetchedAt` marker rather than failing the push. Sources degrade
independently (N3, N1).

## 5. Relay (Cloudflare Worker + KV)

- `POST /v1/push` — bearer `PUSH_TOKEN`. Body = machine snapshot. Validates,
  stamps `receivedAt`, `KV.put("machine:<id>", body, {expirationTtl: 7d})`.
- `GET /v1/summary` — bearer `READ_TOKEN`. Lists `machine:*` keys (≤ handful),
  merges: **tokens** = sum across machines; **limits/quota** = value with the
  newest `fetchedAt`; includes per-machine `lastSeen` and overall `ageSec`.
  Response shaped exactly for the firmware (schema §6) so device-side parsing
  stays trivial.
- Secrets via `wrangler secret`. Reject anything else with 401. No PII stored
  beyond hostnames and usage numbers.

## 6. Data contract

Schema `v1`, as **shipped** (verified against `collector/src/snapshot.js`,
`collector/src/sources/*.js` and `relay/src/merge.js`).

### 6.1 Machine snapshot (collector → relay, `POST /v1/push`)

```json
{
  "v": 1,
  "machineId": "wsl-desktop",
  "sentAt": "2026-08-13T15:04:05.000Z",
  "claude": {
    "limits": {
      "fetchedAt": "2026-08-13T15:03:48.000Z",
      "session":   { "pct": 13.4, "resetsAt": "2026-08-13T19:30:00Z" },
      "weekly":    { "pct": 51.0, "resetsAt": "2026-08-16T09:00:00Z" },
      "extra":     [ { "label": "opus", "pct": 30.0, "resetsAt": "2026-08-16T09:00:00Z" } ],
      "extraUsage": { "usedCreditsUsd": 12.34 }
    },
    "tokens": {
      "computedAt": "2026-08-13T15:04:05.000Z",
      "today":   { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "week":    { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "month":   { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "allTime": { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "costUsd": { "month": 0.0, "allTime": 0.0 }
    }
  },
  "codex": {
    "limits": {
      "fetchedAt": "2026-08-13T15:03:50.000Z",
      "fiveHour": { "pct": 10.0, "resetsAt": "2026-08-13T18:00:00Z" },
      "weekly":   { "pct": 27.0, "resetsAt": "2026-08-16T00:00:00Z" },
      "plan": "plus"
    }
  },
  "copilot": {
    "quota": {
      "fetchedAt": "2026-08-13T14:59:00.000Z",
      "used": 143, "included": 300, "pctUsed": 47.7,
      "resetsAt": "2026-09-01T00:00:00.000Z", "plan": "business"
    }
  }
}
```

Rules:
- Any section (`claude.limits`, `claude.tokens`, `codex.limits`, `copilot.quota`)
  may be `null`; so may any window inside one. `extra` is Claude's per-model /
  per-scope weekly buckets (label from the vendor scope), `[]` when there are none.
- `extraUsage` is pay-as-you-go credits beyond the plan (`null` when the vendor
  omits `extra_usage`); see §14.
- Copilot `included: null` means *unlimited* (the vendor's `unlimited` flag), and
  `pctUsed` is then `0`.
- Every window's `resetsAt` is copied **verbatim from the vendor payload** — it is
  true absolute wall-clock time, not the collector's clock. `sentAt`, `fetchedAt`
  and `computedAt` are the only fields minted by the collector's clock.
- `machineId` must match `/^[\w.-]{1,64}$/`; the body must be ≤ 32 KB (the relay
  rejects otherwise with 400/413).
- The relay stamps `receivedAt` (its own clock) onto the stored copy. Collectors
  never send it.
- Response is `{"ok":true}`, or `{"ok":true,"skipped":true}` when the relay decided
  the snapshot was not worth a KV write (see 6.3).

### 6.2 Summary (relay → device, `GET /v1/summary`)

```json
{
  "v": 1,
  "serverTime": "2026-08-13T15:04:17.000Z",
  "machines": [ { "id": "wsl-desktop", "ageSec": 12 } ],
  "claude": {
    "limits": {
      "ageSec": 29,
      "session": { "pct": 13.4, "resetsInSec": 15943 },
      "weekly":  { "pct": 51.0, "resetsInSec": 236743 },
      "extra":   [ { "label": "opus", "pct": 30.0, "resetsInSec": 236743 } ],
      "extraUsage": { "usedCreditsUsd": 12.34 }
    },
    "tokens": {
      "ageSec": 12,
      "today":   { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "week":    { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "month":   { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "allTime": { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
      "costUsd": { "month": 0.0, "allTime": 0.0 }
    }
  },
  "codex":   { "limits": { "ageSec": 27, "fiveHour": { "pct": 10.0, "resetsInSec": 10543 },
                            "weekly": { "pct": 27.0, "resetsInSec": 118543 }, "plan": "plus" } },
  "copilot": { "quota":  { "ageSec": 317, "used": 143, "included": 300, "pctUsed": 47.7,
                            "resetsInSec": 1585543, "plan": "business" } }
}
```

Merge and freshness rules (`relay/src/merge.js`):
- **No ISO timestamps leave the relay except `serverTime`.** Every instant is a
  relative integer: `ageSec` (seconds since the data was captured, never negative)
  and `resetsInSec` (may be negative once a window has rolled over). The device
  needs no correct clock — it adds its own elapsed-time counter to `ageSec`.
- **Ages are clock-skew-free.** The relay never subtracts a collector timestamp
  from its own clock. Per snapshot and section:
  `ageSec = max(0, (serverTime − receivedAt) + (sentAt − fetchedAt))` — the first
  delta is measured entirely on the relay's clock, the second entirely on the
  collector's, so a drifting collector (WSL2 after suspend/resume) cancels out.
  `machines[].ageSec = max(0, serverTime − receivedAt)`. `resetsInSec` stays
  anchored to the relay clock because `resetsAt` is vendor-absolute (6.1).
- **`claude.limits` / `codex.limits` / `copilot.quota`: freshest machine wins**,
  ranked by the smallest skew-corrected `ageSec` (not by raw `fetchedAt`). Sections
  that carry no usable value, or whose shape is broken, are skipped rather than
  allowed to win; one malformed snapshot in KV can never fail the whole summary.
- **`claude.tokens`: summed across machines**, and a machine whose tokens are older
  than **24h is excluded from the sums** so a box that went offline stops inflating
  "today"/"week" for the KV TTL. `tokens.ageSec` is the oldest *included*
  contributor. All contributors stale ⇒ `claude.tokens: null`.
- `machines[]` always lists **every** stored machine, including excluded/stale ones.
- Any section may be `null` (device renders "no data yet"); a `pct` may be `null`
  inside a present section.

### 6.3 Freshness, write budget and the F8 latency addendum

F8 ("token figures within ~90s of activity") predates the KV-budget work. The
Cloudflare free plan allows **1,000 KV writes/day and 1,000 list ops/day**, while
the shipped cadences (collector push every 30s, device poll every 20s) would spend
2,880 writes and 4,320 lists per day — the relay would start throwing mid-afternoon
and the display would go dark for the rest of the UTC day. The relay therefore
spends writes deliberately (`relay/src/worker.js`):

| change in an incoming snapshot | KV write |
| --- | --- |
| machine not in KV yet | immediately |
| vendor limit/quota **values** changed (pct, resets, plan, extraUsage) | immediately |
| only `claude.tokens` changed | at most once per **150 s** |
| nothing changed (only timestamps moved) | heartbeat every **300 s**, which also refreshes the 7-day TTL and keeps `machines[].ageSec` honest |

and `KV.list('machine:')` is cached per Worker isolate for **300 s** — machine
*values* are still read fresh on every request, only the key list is cached, so a
brand-new machine can take up to 5 minutes to appear in `machines[]`.

**F8 addendum (revised targets).** Token totals persist within **≤150 s** of being
computed and reach the device within **≤~170 s** worst case (150 s write deferral +
20 s device poll). Vendor limit percentages are unchanged at ~5 min end to end
(5 min collector poll + ≤30 s push + 20 s device poll), because value changes are
never deferred. Reported `ageSec` for an unchanged section can lag reality by up to
the 300 s heartbeat — still well under the firmware's 600 s stale-chip threshold.
Steady-state cost is roughly 300-500 writes/day and ≤288 lists/day per collector;
the 1,000/day ceiling is shared across machines, so ~2 collectors fit comfortably
and a third would want a longer `PUSH_EVERY_MS` or a `machines` index key.

## 7. Firmware

### Hardware facts (verified against board docs at bring-up)
ESP32-S3 (16MB flash / 8MB octal PSRAM), 4.0" 480×480 IPS, ST7701S driver on
16-bit parallel RGB with SPI init, GT911 capacitive touch on I2C, PWM backlight.
Exact pin map comes from the vendor/community config for ESP32-4848S040 at
milestone 1 — it is a constants file, not a design question.

### Stack
PlatformIO (pioarduino espressif32 platform, Arduino core 3.x / IDF 5.x),
Arduino_GFX (`Arduino_RGB_Display` + ST7701 init), LVGL 9 (buffers in PSRAM,
partial double-buffer), GT911 touch driver, ArduinoJson, HTTPS via
`WiFiClientSecure` with embedded root CAs covering Cloudflare's cert chains
(Let's Encrypt ISRG X1 + Google Trust Services); NTP via `configTime` with a
compile-time POSIX TZ constant (needed for reset countdowns and the clock).

### Modules
- `wifi_mgr` — NVS-backed credential store (≤8 networks, FIFO eviction);
  non-blocking state machine on WiFi events: boot-scan → join strongest known →
  on drop: retry current, then rescan every 30s. Exposes state + scan results to UI.
- `net` — polls `GET /v1/summary` every 20s on a timer (read token from
  `secrets.h`, gitignored, compile-time); parses into `model::UsageSnapshot`;
  publishes via a dirty flag the UI picks up. Runs on its own FreeRTOS task so
  the LVGL loop never blocks (N5).
- `model` — plain structs mirroring §6 + formatting helpers (`12.4M`, `$41.20`,
  countdown strings).
- `ui` — LVGL tileview with 5 pages (order: Claude, Codex, Copilot, Tokens,
  Settings), shared status bar, dark theme with per-service accent colors,
  page dots. Gauges/arcs for 5h limits, bars for weekly/monthly. Settings page
  hosts the WiFi flow: scan list → tap SSID → LVGL keyboard widget → join +
  save. Also shows relay status/data age and firmware version.
- `main` — init order: display → LVGL → NVS/wifi_mgr → UI → NTP → net task.

### First-boot flow
No saved networks → tileview locked to Settings page with a prompt; after the
first successful join, unlock and slide to the Claude page.

## 8. Error handling

| Failure | Behavior |
|---|---|
| WiFi down | Banner "WiFi disconnected — reconnecting…", keep last data, wifi_mgr rescans |
| Relay unreachable / 5xx | Freshness dot amber→red, "stale Xm" badge; silent retry next cycle |
| Relay 401 | Persistent banner "Relay auth rejected — check device token" |
| A vendor source errors (collector) | That section carries last value + stale `fetchedAt`; other sources unaffected; push continues |
| Claude OAuth token expired | Limits marked stale on that machine; freshest machine wins in merge; self-heals next time Claude Code runs |
| Anthropic 429 | Collector honors retry-after + backoff (known behavior of this endpoint) |
| JSONL parse anomalies | Skip malformed lines, count them in collector log, never crash |
| Device power loss | All credentials/settings in NVS; cold boot rejoins and repolls in <15s |

## 9. Security

- Vendor credentials never leave the machines they already live on (N2/N3).
- Relay requires bearer tokens on both endpoints; tokens are long random
  strings; push and read are separate so the device token can't publish.
- Device stores WiFi creds + read token in NVS; `secrets.h` is gitignored.
- Relay stores only usage numbers + hostnames, 7-day TTL.

## 10. Testing

- **Collector:** `node --test` unit tests — fixture JSONL trees → exact token
  totals/dedupe/window bucketing; normalizers for each vendor response (fixture
  JSON from live captures); price-table cost math. One live smoke command
  (`collector --once --print`) that prints the snapshot without pushing.
- **Relay:** unit test the merge function (sum + freshest-wins + staleness);
  `wrangler dev` + curl smoke for auth paths (401/200).
- **Firmware:** milestone bring-up, each verified on hardware before the next:
  (1) backlight + display test pattern → (2) touch coords echo → (3) LVGL demo
  page at usable FPS → (4) WiFi join + NTP → (5) HTTPS GET summary parsed →
  (6) full UI with live data → (7) WiFi setup flow end-to-end (add/forget/auto-rejoin).
- **End-to-end:** collector (real data) → relay (deployed) → device on desk.

## 11. Rollout

1. Relay deployed first (wrangler), tokens generated.
2. Collector installed as systemd user service on this machine.
3. Firmware flashed from WSL2 via usbipd USB passthrough (documented); later
   machines get collector via a small install script + README.

## 12. Out of scope (v1) / future

- Codex & Copilot token counts; OTA updates; auto-brightness/night mode;
  captive-portal fallback; Windows/macOS collector service wrappers (docs only);
  per-machine token breakdown screen; historical charts.

## 13. Risks & mitigations

- **Undocumented vendor endpoints change** (Anthropic oauth/usage, ChatGPT wham,
  copilot_internal): all normalizers isolated in collector (one file per vendor)
  with fixtures, so fixes are small and don't touch firmware; session-file
  fallback for Codex; billing-API fallback for Copilot. Firmware only ever
  speaks to our relay contract.
- **Anthropic 429 sensitivity:** ≥5-min poll + retry-after compliance + jitter.
- **Org-paid Copilot may hide billing data:** primary path (`copilot_internal/user`)
  is plan-agnostic; if both paths fail we render "n/a" rather than fake zeros.
- **WSL2 USB flashing friction:** usbipd attach documented; fallback = build in
  WSL, flash the merged bin with esptool on Windows.
- **RGB-panel + PSRAM contention artifacts** (known S3 quirk): use vendor-proven
  timings from the community config; if tearing appears, drop pixel clock and/or
  enable bounce buffers — well-trodden fixes.

## 14. Post-v1 addenda (2026-08-13)

- **Usage credits (additive schema field).** The Anthropic `/api/oauth/usage`
  response carries `extra_usage: {is_enabled, used_credits, currency,
  decimal_places, …}` — pay-as-you-go credits spent beyond the plan's included
  usage. The collector normalizes this to `claude.limits.extraUsage.usedCreditsUsd`
  (dollars, converted from minor units via `used_credits / 10**decimal_places`)
  and the relay passes it through unchanged in the merged summary
  (freshest-machine-wins, same as the rest of `claude.limits`). This is a purely
  additive field on the schema v1 contract (§6): `null` when the vendor omits
  `extra_usage`, so older collector snapshots and any client that doesn't know
  about the field keep working unmodified. Firmware parses it tolerantly and
  renders "Usage credits: $X.XX spent" on the Claude screen.
- **UI layout change (Claude tokens page).** During M6 hardware verification,
  user requested moving the Claude token totals off the horizontal swipe strip:
  the tileview is now **4 horizontal pages** (Claude, Codex, Copilot, Settings)
  with page dots, and the Claude tokens view is reached by swiping **up**
  vertically from the Claude page instead of occupying a 5th horizontal slot.
  Rationale: tokens are a drill-down detail of Claude usage, not a peer
  top-level category alongside the three vendor screens.
