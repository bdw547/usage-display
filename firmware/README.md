# usage-display firmware

Guition ESP32-4848S040C_I (4.0" 480x480, ST7701S RGB panel + GT911 capacitive touch). Four
horizontal pages — Claude limits, Codex limits, Copilot premium requests, Settings/WiFi — plus a
fifth, Claude token totals, that hangs off the Claude page as a swipe-*down* tile rather than
sitting in the horizontal carousel.

## Build & flash
1. `cp include/secrets.h.example include/secrets.h` — fill RELAY_URL + RELAY_READ_TOKEN
   (from `~/.config/usage-collector/tokens.json`) and your TZ.
2. WSL2: attach USB per `docs/flashing-wsl2.md`.
3. `pio run -t upload && pio device monitor`

## UX
- Swipe left/right between Claude / Codex / Copilot / Settings; swipe down from Claude for
  Tokens, and up from Tokens back to Claude. The four dots at the bottom track the horizontal
  position only — Claude and Tokens share a dot, since they're the same column.
- Status bar: WiFi SSID + clock + freshness dot (green <90s since the last good relay poll, amber
  <5m, red otherwise) + connected machine count.
- Per-source stale chips: each data screen (Claude, Codex, Copilot, Tokens) shows a small muted
  "as of Xm ago" chip, top-right, whenever that section's own effective age (the relay's reported
  `ageSec` for that section, plus time held on-device since the last poll) exceeds 10 minutes —
  e.g. the Codex screen will typically show this day-to-day, since its numbers only move when a
  Codex session actually runs. Once a "resets in ..." countdown would itself have already lapsed
  under a stale section, it renders "resets: --" instead of a frozen or misleading time.
- Claude's page also shows a "Usage credits: $X spent" row when the relay reports extra usage
  credits, and up to 3 extra scoped-limit rows (e.g. opus/sonnet) stacked below the Weekly bar.
- Error banner (below the status bar), in priority order: "WiFi disconnected -
  reconnecting..." (wifi down but a network is saved) beats "Relay auth rejected - check device
  token" (relay returned 401) beats "Data stale - relay unreachable?" (wifi and auth are fine, but
  the last successful poll is more than 5 minutes old — covers the relay being down or erroring,
  not just a transient blip).
- Settings page: add networks via scan + on-screen keyboard (up to 8 remembered, strongest signal
  wins on reconnect), forget with the trash icon, see live connection + relay-freshness status.
  First boot lands here automatically and swipe is locked until a network is saved.

## Data path
Device polls `GET <RELAY_URL>/v1/summary` every 20s over TLS (roots in `include/certs.h`). All
freshness/countdown math uses relative seconds carried in the payload (`ageSec` per section,
`resetsInSec`) plus on-device elapsed time; NTP is only used for the status-bar clock, never for
freshness or countdown logic.

## Hardware notes
- RGB-panel/PSRAM contention caused visible tearing under real UI redraw load (not reproduced by
  M3's plain test-pattern screen). Fixed with two paired changes: a small internal-SRAM bounce
  buffer between the PSRAM framebuffer and the panel's continuous pixel-clock DMA
  (`display.cpp`, `bounce_buffer_size_px`), and moving LVGL's own draw buffers out of PSRAM into
  internal DMA-capable RAM (`lvgl_port.cpp`, `heap_caps_malloc(..., MALLOC_CAP_INTERNAL |
  MALLOC_CAP_DMA)`, falling back to PSRAM only if that allocation fails). User-confirmed fixed on
  hardware; see `lvgl_port.cpp`/`display.cpp` comments if the glitch ever resurfaces.
- Device secrets are relay-scoped only: `secrets.h` holds a single read-only relay bearer token —
  no Anthropic/GitHub/Copilot credentials ever reach the firmware or the built binary.
