// firmware/src/ui/settings.cpp
#include "settings.h"
#include "theme.h"
#include "board.h"
#include "../wifi_mgr.h"
#include "../net.h"
#include "../model.h"

static lv_obj_t *connLabel, *relayLabel, *savedList, *scanModal = nullptr;
static lv_obj_t *scanList, *scanSpinner, *kbModal = nullptr;
static String pendingSsid;

static void rebuildSavedList();

// ---- password keyboard modal ----
static void openKeyboard(const String &ssid) {
  pendingSsid = ssid;
  kbModal = lv_obj_create(lv_layer_top());
  lv_obj_set_size(kbModal, SCREEN_W, SCREEN_H);
  lv_obj_set_style_bg_color(kbModal, COL_BG, 0);
  lv_obj_t *title = lv_label_create(kbModal);
  lv_label_set_text_fmt(title, "Password for %s", ssid.c_str());
  lv_obj_set_style_text_color(title, COL_TEXT, 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);
  lv_obj_t *ta = lv_textarea_create(kbModal);
  lv_textarea_set_one_line(ta, true);
  lv_textarea_set_password_mode(ta, true);
  lv_obj_set_width(ta, 400);
  lv_obj_align(ta, LV_ALIGN_TOP_MID, 0, 50);
  lv_obj_t *kb = lv_keyboard_create(kbModal);
  lv_keyboard_set_textarea(kb, ta);
  lv_obj_set_size(kb, SCREEN_W, 220);
  lv_obj_align(kb, LV_ALIGN_BOTTOM_MID, 0, 0);
  // READY (checkmark) = connect; CANCEL (keyboard icon) = close
  lv_obj_add_event_cb(kb, [](lv_event_t *e) {
    lv_obj_t *kb = (lv_obj_t *)lv_event_get_target(e);
    lv_obj_t *ta = lv_keyboard_get_textarea(kb);
    if (lv_event_get_code(e) == LV_EVENT_READY) {
      wifi_mgr_connect_to(pendingSsid, lv_textarea_get_text(ta));
      lv_obj_delete(kbModal); kbModal = nullptr;
      if (scanModal) { lv_obj_delete(scanModal); scanModal = nullptr; }
      rebuildSavedList();
    } else if (lv_event_get_code(e) == LV_EVENT_CANCEL) {
      lv_obj_delete(kbModal); kbModal = nullptr;
    }
  }, LV_EVENT_ALL, nullptr);
}

// ---- scan modal ----
static void openScan() {
  wifi_mgr_request_scan();
  scanModal = lv_obj_create(lv_layer_top());
  lv_obj_set_size(scanModal, SCREEN_W, SCREEN_H);
  lv_obj_set_style_bg_color(scanModal, COL_BG, 0);
  lv_obj_t *title = lv_label_create(scanModal);
  lv_label_set_text(title, "Choose a network");
  lv_obj_set_style_text_color(title, COL_TEXT, 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);
  lv_obj_t *close = lv_button_create(scanModal);
  lv_obj_align(close, LV_ALIGN_TOP_RIGHT, -10, 8);
  lv_obj_t *x = lv_label_create(close);
  lv_label_set_text(x, LV_SYMBOL_CLOSE);
  lv_obj_add_event_cb(close, [](lv_event_t *) { lv_obj_delete(scanModal); scanModal = nullptr; }, LV_EVENT_CLICKED, nullptr);
  scanSpinner = lv_spinner_create(scanModal);
  lv_obj_set_size(scanSpinner, 60, 60);
  lv_obj_center(scanSpinner);
  scanList = lv_list_create(scanModal);
  lv_obj_set_size(scanList, SCREEN_W - 24, SCREEN_H - 70);
  lv_obj_align(scanList, LV_ALIGN_BOTTOM_MID, 0, -8);
  lv_obj_set_style_bg_color(scanList, COL_BG, 0);
}

static void onScanResults(std::vector<std::pair<String, int>> &nets) {
  if (!scanModal) return;
  lv_obj_add_flag(scanSpinner, LV_OBJ_FLAG_HIDDEN);
  for (auto &n : nets) {
    String txt = n.first + "  (" + String(n.second) + " dBm)";
    lv_obj_t *btn = lv_list_add_button(scanList, LV_SYMBOL_WIFI, txt.c_str());
    lv_obj_set_user_data(btn, new String(n.first)); // freed on click
    lv_obj_add_event_cb(btn, [](lv_event_t *e) {
      String *ssid = (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
      openKeyboard(*ssid);
      delete ssid;
    }, LV_EVENT_CLICKED, nullptr);
  }
}

// ---- saved networks list ----
static void rebuildSavedList() {
  lv_obj_clean(savedList);
  for (auto &c : wifi_mgr_saved()) {
    lv_obj_t *btn = lv_list_add_button(savedList, LV_SYMBOL_SAVE, c.ssid.c_str());
    lv_obj_t *trash = lv_button_create(btn);
    lv_obj_t *tl = lv_label_create(trash);
    lv_label_set_text(tl, LV_SYMBOL_TRASH);
    lv_obj_align(trash, LV_ALIGN_RIGHT_MID, 0, 0);
    lv_obj_set_user_data(trash, new String(c.ssid));
    lv_obj_add_event_cb(trash, [](lv_event_t *e) {
      String *ssid = (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
      wifi_mgr_forget(*ssid);
      delete ssid;
      rebuildSavedList();
    }, LV_EVENT_CLICKED, nullptr);
  }
  if (wifi_mgr_saved().empty()) lv_list_add_text(savedList, "No saved networks - add one below");
}

void settings_build(lv_obj_t *tile) {
  lv_obj_set_style_bg_color(tile, COL_BG, 0);
  lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_t *title = lv_label_create(tile);
  lv_label_set_text(title, "Settings");
  lv_obj_set_style_text_color(title, COL_TEXT, 0);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 10);

  connLabel = lv_label_create(tile);
  lv_obj_set_style_text_color(connLabel, COL_MUTED, 0);
  lv_obj_align(connLabel, LV_ALIGN_TOP_LEFT, 16, 54);
  relayLabel = lv_label_create(tile);
  lv_obj_set_style_text_color(relayLabel, COL_MUTED, 0);
  lv_obj_align(relayLabel, LV_ALIGN_TOP_LEFT, 16, 80);

  lv_obj_t *addBtn = lv_button_create(tile);
  lv_obj_align(addBtn, LV_ALIGN_TOP_RIGHT, -16, 50);
  lv_obj_t *al = lv_label_create(addBtn);
  lv_label_set_text(al, LV_SYMBOL_PLUS " Add network");
  lv_obj_add_event_cb(addBtn, [](lv_event_t *) { openScan(); }, LV_EVENT_CLICKED, nullptr);

  lv_obj_t *cap = lv_label_create(tile);
  lv_label_set_text(cap, "Saved networks (tap trash to forget)");
  lv_obj_set_style_text_color(cap, COL_MUTED, 0);
  lv_obj_align(cap, LV_ALIGN_TOP_LEFT, 16, 116);
  savedList = lv_list_create(tile);
  lv_obj_set_size(savedList, SCREEN_W - 32, 220);
  lv_obj_align(savedList, LV_ALIGN_TOP_MID, 0, 140);
  lv_obj_set_style_bg_color(savedList, COL_CARD, 0);
  rebuildSavedList();

  lv_obj_t *about = lv_label_create(tile);
  lv_label_set_text(about, "usage-display v1.0");
  lv_obj_set_style_text_color(about, COL_MUTED, 0);
  lv_obj_align(about, LV_ALIGN_BOTTOM_MID, 0, -12);
}

void settings_tick() {
  if (wifi_mgr_state() == WifiState::CONNECTED)
    lv_label_set_text_fmt(connLabel, LV_SYMBOL_WIFI " %s - %s - %d dBm",
                          wifi_mgr_ssid().c_str(), wifi_mgr_ip().c_str(), wifi_mgr_rssi());
  else
    lv_label_set_text(connLabel, LV_SYMBOL_WARNING " not connected");
  char agebuf[16];
  uint32_t ok = net_last_ok_ms();
  if (ok) { fmt_age((int32_t)((millis() - ok) / 1000), agebuf, sizeof(agebuf)); lv_label_set_text_fmt(relayLabel, "relay: last update %s ago", agebuf); }
  else lv_label_set_text(relayLabel, "relay: no data yet");
  std::vector<std::pair<String, int>> nets;
  if (wifi_mgr_scan_done(nets)) onScanResults(nets);
}
