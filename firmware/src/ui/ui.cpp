// firmware/src/ui/ui.cpp
#include "ui.h"
#include "screens.h"
#include "settings.h"
#include "theme.h"
#include "board.h"     // SCREEN_W/H (include/ is on the include path)
#include "../wifi_mgr.h"
#include "../net.h"
#include <time.h>

// 2D tile map (Finding B, M6 fix round): Tokens hangs off Claude as a swipe-UP page rather than
// sitting in the main horizontal carousel. Grid:
//   col0/row0 Claude --- col1 Codex --- col2 Copilot --- col3 Settings   (LV_DIR_HOR carousel)
//   col0/row1 Tokens (only reachable by swiping down from Claude, and back up from Tokens)
static lv_obj_t *tileview;
static lv_obj_t *tileClaude, *tileTokens, *tileCodex, *tileCopilot, *tileSettings;
static lv_obj_t *sbWifi, *sbClock, *sbDot, *sbMachines, *banner;
static lv_obj_t *dots[4]; // one per COLUMN, not per tile — Claude and Tokens share column 0
static UsageData current;
static bool swipeLocked = false; // Task 8: first-boot lock, set true by main.cpp when no WiFi is saved yet

// Column of the active tile; Claude and Tokens (same column, different row) map to the same dot.
// Finding 7: lv_tileview's tile_act is only ever set by lv_tileview_set_tile()/_by_index() or a
// scroll-end event (confirmed in lv_tileview.c: lv_tileview_add_tile() never touches it) — it is
// NOT set just by adding tiles, so lv_tileview_get_tile_active() can return NULL here (e.g. right
// after ui_init() builds the grid, before any explicit set-tile call or user swipe). Default the
// fallback to column 0 (Claude, the actual home tile), not 3 (Settings) — the null/first-call case
// itself is fixed by ui_init() explicitly calling set_tile_by_index(0,0,...) before first paint;
// this fallback is defense in depth for any other unmatched case.
static int activeColumn() {
  lv_obj_t *active = lv_tileview_get_tile_active(tileview);
  if (active == tileClaude || active == tileTokens) return 0;
  if (active == tileCodex) return 1;
  if (active == tileCopilot) return 2;
  if (active == tileSettings) return 3;
  return 0;
}

static void updateDots() {
  int col = activeColumn();
  for (int i = 0; i < 4; i++)
    lv_obj_set_style_bg_color(dots[i], i == col ? COL_TEXT : COL_CARD, 0);
}

void ui_init() {
  lv_obj_t *scr = lv_screen_active();
  lv_obj_set_style_bg_color(scr, COL_BG, 0);

  // --- status bar (32px) ---
  lv_obj_t *sb = lv_obj_create(scr);
  lv_obj_set_size(sb, SCREEN_W, 32);
  lv_obj_align(sb, LV_ALIGN_TOP_MID, 0, 0);
  lv_obj_set_style_bg_color(sb, COL_BG, 0);
  lv_obj_set_style_border_width(sb, 0, 0);
  lv_obj_set_style_pad_all(sb, 4, 0);
  lv_obj_clear_flag(sb, LV_OBJ_FLAG_SCROLLABLE);
  sbWifi = lv_label_create(sb);
  lv_obj_set_style_text_color(sbWifi, COL_MUTED, 0);
  lv_obj_align(sbWifi, LV_ALIGN_LEFT_MID, 4, 0);
  lv_label_set_text(sbWifi, LV_SYMBOL_WIFI " --");
  sbClock = lv_label_create(sb);
  lv_obj_set_style_text_color(sbClock, COL_TEXT, 0);
  lv_obj_align(sbClock, LV_ALIGN_CENTER, 0, 0);
  lv_label_set_text(sbClock, "--:--");
  sbMachines = lv_label_create(sb);
  lv_obj_set_style_text_color(sbMachines, COL_MUTED, 0);
  lv_obj_align(sbMachines, LV_ALIGN_RIGHT_MID, -26, 0);
  lv_label_set_text(sbMachines, "");
  sbDot = lv_obj_create(sb);
  lv_obj_set_size(sbDot, 12, 12);
  lv_obj_set_style_radius(sbDot, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_border_width(sbDot, 0, 0);
  lv_obj_set_style_bg_color(sbDot, COL_MUTED, 0);
  lv_obj_align(sbDot, LV_ALIGN_RIGHT_MID, -6, 0);

  // --- error banner (hidden by default) ---
  banner = lv_label_create(scr);
  lv_obj_set_style_bg_color(banner, COL_BAD, 0);
  lv_obj_set_style_bg_opa(banner, LV_OPA_COVER, 0);
  lv_obj_set_style_text_color(banner, lv_color_hex(0xFFFFFF), 0);
  lv_obj_set_style_pad_all(banner, 6, 0);
  lv_obj_set_width(banner, SCREEN_W);
  lv_obj_align(banner, LV_ALIGN_TOP_MID, 0, 32);
  lv_obj_add_flag(banner, LV_OBJ_FLAG_HIDDEN);

  // --- tileview: 2D sparse grid (4-column horizontal carousel + Tokens hanging under Claude) ---
  tileview = lv_tileview_create(scr);
  lv_obj_set_size(tileview, SCREEN_W, SCREEN_H - 32 - 18);
  lv_obj_align(tileview, LV_ALIGN_TOP_MID, 0, 32);
  lv_obj_set_style_bg_color(tileview, COL_BG, 0);
  lv_obj_set_scrollbar_mode(tileview, LV_SCROLLBAR_MODE_OFF);
  tileClaude   = lv_tileview_add_tile(tileview, 0, 0, (lv_dir_t)(LV_DIR_HOR | LV_DIR_BOTTOM));
  tileTokens   = lv_tileview_add_tile(tileview, 0, 1, LV_DIR_TOP);
  tileCodex    = lv_tileview_add_tile(tileview, 1, 0, LV_DIR_HOR);
  tileCopilot  = lv_tileview_add_tile(tileview, 2, 0, LV_DIR_HOR);
  tileSettings = lv_tileview_add_tile(tileview, 3, 0, LV_DIR_HOR);
  screen_claude_build(tileClaude);
  screen_codex_build(tileCodex);
  screen_copilot_build(tileCopilot);
  screen_tokens_build(tileTokens);
  lv_obj_add_event_cb(tileview, [](lv_event_t *) { updateDots(); }, LV_EVENT_VALUE_CHANGED, nullptr);

  // --- page dots: 4, one per column (row changes within column 0 don't move them) ---
  for (int i = 0; i < 4; i++) {
    dots[i] = lv_obj_create(scr);
    lv_obj_set_size(dots[i], 8, 8);
    lv_obj_set_style_radius(dots[i], LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(dots[i], 0, 0);
    lv_obj_align(dots[i], LV_ALIGN_BOTTOM_MID, (2 * i - 3) * 9, -5);
  }
  // Finding 7: explicitly land on Claude (col 0) before the first updateDots() call, rather than
  // leaving tile_act at its zero-initialized NULL — see activeColumn()'s comment. main.cpp's
  // first-boot-no-creds call to ui_goto_settings() still runs after ui_init() returns and
  // correctly overrides this when there's really nothing saved to show yet.
  lv_tileview_set_tile_by_index(tileview, 0, 0, LV_ANIM_OFF);
  updateDots();

  settings_build(ui_settings_parent()); // Task 8: settings/WiFi page built inside the col-3 tile
}

void ui_apply(const UsageData &u) {
  Serial.println("ui: applied update"); // deviation (task 7): temporary trace, kept per dispatch note for later milestones
  current = u;
  screen_claude_apply(u);
  screen_codex_apply(u);
  screen_copilot_apply(u);
  screen_tokens_apply(u);
  if (u.machineCount > 0) lv_label_set_text_fmt(sbMachines, "%d pc%s", u.machineCount, u.machineCount == 1 ? "" : "s");
}

void ui_tick_1s() {
  // clock
  time_t t = time(nullptr);
  if (t > 1700000000) { // NTP synced
    struct tm tm; localtime_r(&t, &tm);
    lv_label_set_text_fmt(sbClock, "%d:%02d", tm.tm_hour % 12 == 0 ? 12 : tm.tm_hour % 12, tm.tm_min);
  }
  // wifi
  switch (wifi_mgr_state()) {
    case WifiState::CONNECTED: lv_label_set_text_fmt(sbWifi, LV_SYMBOL_WIFI " %s", wifi_mgr_ssid().c_str()); break;
    case WifiState::CONNECTING:
    case WifiState::SCANNING: lv_label_set_text(sbWifi, LV_SYMBOL_REFRESH " connecting"); break;
    default: lv_label_set_text(sbWifi, LV_SYMBOL_WARNING " no wifi"); break;
  }
  // freshness dot: green <90s, amber <5m, red otherwise (measured from last successful fetch)
  uint32_t ok = net_last_ok_ms();
  int32_t sinceOk = ok == 0 ? INT32_MAX : (int32_t)((millis() - ok) / 1000);
  lv_obj_set_style_bg_color(sbDot, sinceOk < 90 ? COL_GOOD : sinceOk < 300 ? COL_WARN : COL_BAD, 0);
  // banner
  const char *msg = nullptr;
  if (wifi_mgr_state() != WifiState::CONNECTED && wifi_mgr_has_saved()) msg = "WiFi disconnected - reconnecting...";
  else if (net_status() == NetStatus::AUTH_ERROR) msg = "Relay auth rejected - check device token";
  // Task 9 cleanup item 3: was gated on net_status()==OK, which is nearly unsatisfiable together
  // with sinceOk>300 — a poll that succeeds sets lastOkMs to ~now, and any poll that fails moves
  // status away from OK entirely (see net.cpp's netTask), so the relay-down case this banner
  // exists for (HTTP_ERROR/PARSE_ERROR/WIFI_DOWN persisting once the relay stops answering) could
  // never actually show it. Any status except AUTH_ERROR (which keeps its own banner above) now
  // qualifies; precedence stays wifi-down > auth > stale via the else-if chain.
  else if (net_status() != NetStatus::AUTH_ERROR && sinceOk > 300 && sinceOk != INT32_MAX) msg = "Data stale - relay unreachable?";
  if (msg) { lv_label_set_text(banner, msg); lv_obj_clear_flag(banner, LV_OBJ_FLAG_HIDDEN); }
  else lv_obj_add_flag(banner, LV_OBJ_FLAG_HIDDEN);
  // live countdowns between polls
  screens_tick_1s(current);
  // Task 8: the first-boot swipe lock releases itself the moment a network is saved
  if (swipeLocked && wifi_mgr_has_saved()) ui_set_swipe_enabled(true);
  settings_tick();
}

void ui_goto_settings() { lv_tileview_set_tile_by_index(tileview, 3, 0, LV_ANIM_ON); updateDots(); }
lv_obj_t *ui_settings_parent() { return tileSettings; }

// Task 8: swiping is implemented as tileview scrolling, so gating it is inverted from the naive
// reading of "enabled" — clearing SCROLLABLE is what blocks the swipe gesture (lock), adding it
// back is what permits it again (unlock). Only touch/gesture-driven paging is affected; programmatic
// navigation via lv_tileview_set_tile_by_index() (i.e. ui_goto_settings()) still works while locked.
void ui_set_swipe_enabled(bool en) {
  if (en) lv_obj_add_flag(tileview, LV_OBJ_FLAG_SCROLLABLE);
  else lv_obj_clear_flag(tileview, LV_OBJ_FLAG_SCROLLABLE);
  swipeLocked = !en;
}
