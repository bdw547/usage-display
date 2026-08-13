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
  freshness dot (green <90s / amber <5m / red older), and clock.

### Non-functional
- **N1** Never blank on failure: keep last-known data with a "stale Xm" badge.
- **N2** Device holds no vendor credentials and never performs vendor OAuth —
  it only talks to our relay with a device read token.
- **N3** Collector must not interfere with CLI logins (read tokens, never refresh).
- **N4** Cloud costs: fit Cloudflare free tier (device polls ~4.3k/day ≪ 100k reads/day).
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

Machine snapshot (collector → relay), abridged:

```json
{
  "machineId": "wsl-desktop",
  "sentAt": "2026-08-13T15:04:05Z",
  "claude": {
    "limits": { "fetchedAt": "…", "fiveHour": {"pct": 42, "resetsAt": "…"},
                 "sevenDay": {"pct": 61, "resetsAt": "…"},
                 "perModel": [{"name": "opus", "pct": 30, "resetsAt": "…"}] },
    "tokens": { "computedAt": "…",
                 "today": {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0},
                 "week": {…}, "month": {…}, "allTime": {…},
                 "costUsd": {"month": 0.0, "allTime": 0.0} }
  },
  "codex":   { "limits": { "fetchedAt": "…", "fiveHour": {"pct": 0, "resetsAt": "…"},
                            "weekly": {"pct": 0, "resetsAt": "…"} } },
  "copilot": { "quota": { "fetchedAt": "…", "used": 143, "included": 300,
                           "pct": 47.7, "resetsAt": "…", "plan": "…" } }
}
```

Summary (relay → device): same leaf shapes, tokens summed, plus
`{"machines": [{"id", "lastSeenSec"}], "serverTime": "…"}`. Any section may be
`null` (device renders "no data yet"). Numbers may be stale — each carries its
`fetchedAt` and the device renders age from `serverTime` (no reliance on device
clock for freshness).

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
