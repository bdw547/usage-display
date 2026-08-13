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
  First boot lands here automatically and swipe is locked until a network is saved. The scan list
  shows the 12 strongest networks. After 3 consecutive failed connect attempts (e.g. a mistyped
  password) an SSID is skipped for 5 minutes so a weaker-but-working saved network gets a turn;
  re-entering the password from Settings clears that immediately, as does a successful connect.
- Unknown is rendered as unknown, never as zero: if the relay reports a field as null — Copilot
  `used`/`included`/`pctUsed`, or a window's `pct` — the screen shows "--" and omits the bar
  rather than drawing a reassuring 0%. In particular a missing Copilot quota total is never
  labelled "(unlimited)", because the upstream data uses null for both "unlimited plan" and
  "the entitlement field was missing". When a whole section goes null (e.g. right after a collector
  restart), its widgets are blanked before "no data yet" appears — the display never shows "no
  data" on top of a stale percentage.

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
- **Panel timing ladder.** Two named constants at the top of `display.cpp` — `BOUNCE_LINES` and
  `PCLK_HZ` — are the only knobs; the comment block above them carries the full ladder table.
  Currently flashed: **Variant A (bounce 480x10 px, pclk 12MHz)**, after round-2's 480x20 bounce
  was observed to make *steady-state* shimmer worse than round-1's 480x10. If A still shimmers at
  idle, step to B (480x8 @ 14MHz), then C (480x10 @ 10MHz). Judge each variant on hardware: (i)
  idle shimmer/striping across the arc and bars, (ii) glitching while "Add network" is scanning.
  Record the winner here when the ladder terminates.
- Two structural fixes accompany the ladder and are independent of which rung wins:
  - **Boot stagger** (`net.cpp`, `BOOT_STAGGER_MS`): the fetch task waits 2.5s before its first
    poll so WiFi association, the first TLS handshake and the first full LVGL render don't all
    contend with the bounce-buffer refill at once — that pile-up is what desynced panel scanout on
    power-up (image vertically wrapped, header at the bottom).
  - **Post-boot scanout re-sync** (`display.cpp`, `display_boot_resync_tick()` driven from
    `loop()`): calls `esp_lcd_rgb_panel_restart()` once, ~3s after boot. That is the canonical
    recovery for a desynced RGB panel — redrawing cannot fix it, because the offset lives in the
    panel's scan position, not the framebuffer. GFX 1.6.7 keeps the `esp_lcd` panel handle private
    with no accessor, so `display.cpp` reaches it with the standard explicit-instantiation access
    idiom (documented in place) rather than patching the generated `.pio/libdeps` tree.
- LVGL memory: the builtin pool is a fixed, non-expandable static array sized by `LV_MEM_SIZE` in
  `include/lv_conf.h` (64KB). Peak demand is the WiFi scan modal plus the on-screen keyboard, so
  the settings flow deliberately never has both alive at once (the scan modal is torn down, then
  the keyboard is built from a one-shot `lv_timer`), and the scan list is capped at the 12
  strongest SSIDs. `LV_ASSERT_HANDLER` is `abort()` (panic + backtrace + reboot), never `while(1)` —
  a silent hang here was the "password box appears, no keyboard, frozen" failure. `boot complete`
  is preceded by a heap line reporting both the ESP heaps and the LVGL pool's own occupancy.
- Device secrets are relay-scoped only: `secrets.h` holds a single read-only relay bearer token —
  no Anthropic/GitHub/Copilot credentials ever reach the firmware or the built binary.
