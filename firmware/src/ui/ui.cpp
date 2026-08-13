// firmware/src/ui/ui.cpp
#include "ui.h"
#include "screens.h"
#include "theme.h"
#include "board.h"     // SCREEN_W/H (include/ is on the include path)
#include "../wifi_mgr.h"
#include "../net.h"
#include <time.h>

static lv_obj_t *tileview;
static lv_obj_t *tiles[5];
static lv_obj_t *sbWifi, *sbClock, *sbDot, *sbMachines, *banner;
static lv_obj_t *dots[5];
static UsageData current;

static void updateDots() {
  lv_obj_t *active = lv_tileview_get_tile_active(tileview);
  for (int i = 0; i < 5; i++)
    lv_obj_set_style_bg_color(dots[i], tiles[i] == active ? COL_TEXT : COL_CARD, 0);
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

  // --- tileview with 5 horizontal tiles ---
  tileview = lv_tileview_create(scr);
  lv_obj_set_size(tileview, SCREEN_W, SCREEN_H - 32 - 18);
  lv_obj_align(tileview, LV_ALIGN_TOP_MID, 0, 32);
  lv_obj_set_style_bg_color(tileview, COL_BG, 0);
  lv_obj_set_scrollbar_mode(tileview, LV_SCROLLBAR_MODE_OFF);
  for (int i = 0; i < 5; i++) tiles[i] = lv_tileview_add_tile(tileview, i, 0, LV_DIR_HOR);
  screen_claude_build(tiles[0]);
  screen_codex_build(tiles[1]);
  screen_copilot_build(tiles[2]);
  screen_tokens_build(tiles[3]);
  // tiles[4] = settings; built in Task 8
  lv_obj_add_event_cb(tileview, [](lv_event_t *) { updateDots(); }, LV_EVENT_VALUE_CHANGED, nullptr);

  // --- page dots ---
  for (int i = 0; i < 5; i++) {
    dots[i] = lv_obj_create(scr);
    lv_obj_set_size(dots[i], 8, 8);
    lv_obj_set_style_radius(dots[i], LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(dots[i], 0, 0);
    lv_obj_align(dots[i], LV_ALIGN_BOTTOM_MID, (i - 2) * 18, -5);
  }
  updateDots();
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
  else if (net_status() == NetStatus::OK && sinceOk > 300 && sinceOk != INT32_MAX) msg = "Data stale - relay unreachable?";
  if (msg) { lv_label_set_text(banner, msg); lv_obj_clear_flag(banner, LV_OBJ_FLAG_HIDDEN); }
  else lv_obj_add_flag(banner, LV_OBJ_FLAG_HIDDEN);
  // live countdowns between polls
  screens_tick_1s(current);
}

void ui_goto_settings() { lv_tileview_set_tile_by_index(tileview, 4, 0, LV_ANIM_ON); updateDots(); }
lv_obj_t *ui_settings_parent() { return tiles[4]; }
