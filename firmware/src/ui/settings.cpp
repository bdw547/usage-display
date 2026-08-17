// firmware/src/ui/settings.cpp
#include "settings.h"
#include "theme.h"
#include "board.h"
#include "../wifi_mgr.h"
#include "../net.h"
#include "../model.h"

static lv_obj_t *connLabel, *relayLabel, *savedList, *scanModal = nullptr;
static lv_obj_t *scanList = nullptr, *scanSpinner = nullptr, *kbModal = nullptr;
// pendingSsid is the ONLY copy of the tapped SSID that outlives the scan modal (F9b): the row
// button's heap String dies with the modal, which is now torn down before the keyboard is built.
static String pendingSsid;
// Final-review F9b: set between the row tap and the deferred keyboard creation, so a second tap in
// that ~30ms window can't queue a second keyboard (kbModal is still null during it).
static bool kbPending = false;

static const size_t MAX_SCAN_ROWS = 12; // F6: cap LVGL allocations from a dense-RF scan

static void rebuildSavedList();

// ---- password keyboard modal ----
// Built from a one-shot lv_timer (see the row-click handler) so the scan list is already freed when
// these allocations happen. Reads pendingSsid — no reference into any soon-to-die LVGL user_data.
static void openKeyboard(const String &ssid) {
  if (kbModal) return; // Finding B guard: no double-modal stacking from a double-tap
  kbModal = lv_obj_create(lv_layer_top());
  lv_obj_set_size(kbModal, SCREEN_W, SCREEN_H);
  lv_obj_set_style_bg_color(kbModal, COL_BG, 0);
  lv_obj_t *title = lv_label_create(kbModal);
  lv_label_set_text_fmt(title, "Password for %s", ssid.c_str());
  lv_obj_set_style_text_color(title, COL_TEXT, 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);
  // Finding B: explicit, visible way out (previously only READY/CANCEL on the keyboard itself
  // closed this modal, and the user reported no way to escape it). Same style/size as the scan
  // modal's own close button below (Finding C: >=44x44 touch target).
  lv_obj_t *close = lv_button_create(kbModal);
  lv_obj_set_size(close, 44, 44);
  lv_obj_align(close, LV_ALIGN_TOP_RIGHT, -10, 8);
  lv_obj_t *cx = lv_label_create(close);
  lv_label_set_text(cx, LV_SYMBOL_CLOSE);
  lv_obj_center(cx);
  lv_obj_add_event_cb(close, [](lv_event_t *) { lv_obj_delete(kbModal); kbModal = nullptr; }, LV_EVENT_CLICKED, nullptr);
  lv_obj_t *ta = lv_textarea_create(kbModal);
  lv_textarea_set_one_line(ta, true);
  lv_textarea_set_password_mode(ta, true);
  lv_obj_set_width(ta, 400);
  lv_obj_align(ta, LV_ALIGN_TOP_MID, 0, 50);
  // Readability fix: the dark theme (lvgl_port.cpp) already gives this light-on-dark, but the
  // password field is the one place where an unreadable glyph costs the user a failed join, so its
  // contrast is pinned explicitly rather than inherited — card bg, bright text, muted placeholder.
  lv_obj_set_style_bg_color(ta, COL_CARD, 0);
  lv_obj_set_style_text_color(ta, COL_TEXT, 0);
  lv_obj_set_style_border_color(ta, COL_MUTED, 0);
  lv_textarea_set_placeholder_text(ta, "password");
  lv_obj_set_style_text_color(ta, COL_MUTED, LV_PART_TEXTAREA_PLACEHOLDER);
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
      // scanModal is normally already gone (the row tap tears it down before this modal exists);
      // this stays as a belt-and-braces cleanup for any other path into the keyboard.
      if (scanModal) { lv_obj_delete(scanModal); scanModal = nullptr; scanList = nullptr; scanSpinner = nullptr; }
      rebuildSavedList();
    } else if (lv_event_get_code(e) == LV_EVENT_CANCEL) {
      lv_obj_delete(kbModal); kbModal = nullptr;
    }
  }, LV_EVENT_ALL, nullptr);
  lv_obj_move_foreground(kbModal); // Finding B: defense in depth, on top of the one-modal-at-a-time restructure below
}

// ---- scan modal ----
static void openScan() {
  if (scanModal) return; // Finding B guard: no double-modal stacking from a double-tap
  wifi_mgr_request_scan();
  scanModal = lv_obj_create(lv_layer_top());
  lv_obj_set_size(scanModal, SCREEN_W, SCREEN_H);
  lv_obj_set_style_bg_color(scanModal, COL_BG, 0);
  lv_obj_t *title = lv_label_create(scanModal);
  lv_label_set_text(title, "Choose a network");
  lv_obj_set_style_text_color(title, COL_TEXT, 0);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);
  lv_obj_t *close = lv_button_create(scanModal);
  lv_obj_set_size(close, 44, 44); // Finding C: >=44x44 touch target (was content-sized, easy to miss)
  lv_obj_align(close, LV_ALIGN_TOP_RIGHT, -10, 8);
  lv_obj_t *x = lv_label_create(close);
  lv_label_set_text(x, LV_SYMBOL_CLOSE);
  lv_obj_center(x);
  lv_obj_add_event_cb(close, [](lv_event_t *) {
    if (!scanModal) return;
    lv_obj_delete(scanModal); scanModal = nullptr; scanList = nullptr; scanSpinner = nullptr;
  }, LV_EVENT_CLICKED, nullptr);
  scanSpinner = lv_spinner_create(scanModal);
  lv_obj_set_size(scanSpinner, 60, 60);
  lv_obj_center(scanSpinner);
  scanList = lv_list_create(scanModal);
  lv_obj_set_size(scanList, SCREEN_W - 24, SCREEN_H - 70);
  lv_obj_align(scanList, LV_ALIGN_BOTTOM_MID, 0, -8);
  lv_obj_set_style_bg_color(scanList, COL_BG, 0);
}

// One-shot timer body (F9b): runs ~30ms after a scan row is tapped, i.e. after lv_obj_delete_async
// has actually torn the scan modal (list rows + their Strings + the spinner) down. The keyboard —
// the single largest LVGL allocation in this firmware, ~35 buttons plus its matrix maps — is
// therefore never resident at the same time as the scan list. That co-residency against a fixed
// 48KB pool (now 64KB, F9a) is what exhausted lv_malloc and tripped the old silent-while(1)
// LV_ASSERT_HANDLER, producing the user's "password box appears, no keyboard, device frozen".
static void openKeyboardDeferred(lv_timer_t *) {
  kbPending = false;
  openKeyboard(pendingSsid);
}

static void onScanResults(std::vector<std::pair<String, int>> &nets) {
  if (!scanModal || !scanList) return;
  if (scanSpinner) lv_obj_add_flag(scanSpinner, LV_OBJ_FLAG_HIDDEN);
  if (nets.empty()) {
    lv_obj_t *t = lv_list_add_text(scanList, "No networks found - close and retry");
    lv_obj_set_style_text_color(t, COL_MUTED, 0);
    return;
  }
  // F6: hard cap on rows. `nets` is sorted by RSSI descending (wifi_mgr_scan_done), so this keeps
  // the 12 strongest. Each row is 3 LVGL objects plus a heap String; a dense apartment/office scan
  // returning 30-50 SSIDs would otherwise allocate ~15-20KB of the fixed pool for the list alone.
  size_t shown = 0;
  for (auto &n : nets) {
    if (shown++ >= MAX_SCAN_ROWS) break;
    String txt = n.first + "  (" + String(n.second) + " dBm)";
    lv_obj_t *btn = lv_list_add_button(scanList, LV_SYMBOL_WIFI, txt.c_str());
    lv_obj_set_style_text_color(btn, COL_TEXT, 0); // readability: pin row contrast on the dark list bg
    lv_obj_set_user_data(btn, new String(n.first));
    // Fix round 1 (Critical): ownership moved to the LVGL delete lifecycle. The previous
    // "delete on click" freed the String while the button (and its dangling user_data) stayed
    // alive whenever only kbModal closed (CANCEL) — a second tap on the same button was a
    // use-after-free, and closing it again (or another connect) was a double-free. Freeing
    // exactly once in LV_EVENT_DELETE means it's released when — and only when — the button
    // itself is actually destroyed (modal close via X, keyboard READY closing scanModal, or any
    // future lv_obj_clean), regardless of how many times CLICKED fires first.
    lv_obj_add_event_cb(btn, [](lv_event_t *e) {
      delete (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
    }, LV_EVENT_DELETE, nullptr);
    lv_obj_add_event_cb(btn, [](lv_event_t *e) {
      String *ssid = (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
      if (!ssid) return;
      // Fix round 3 (Critical) + F9b: one guard for both re-entrancy windows — a second tap while
      // the keyboard already exists, and a second tap in the ~30ms gap before it is created.
      // Without it a re-entry would hit lv_obj_delete_async(nullptr) -> LV_ASSERT_NULL.
      if (kbModal || kbPending) return;
      // F9b step 1: COPY the ssid out of the doomed LVGL object graph BEFORE anything is queued for
      // deletion. Everything downstream (openKeyboardDeferred, the READY handler's
      // wifi_mgr_connect_to) reads pendingSsid, never this pointer — the String it points at is
      // freed by btn's LV_EVENT_DELETE handler when the async teardown below actually runs.
      pendingSsid = *ssid;
      // F9b step 2: hide immediately so the UI reacts on this frame (the async delete lands a few
      // ms later), then tear the scan modal down. MUST be the async variant: this deletes
      // scanModal, the ANCESTOR of btn, whose CLICKED event is still being dispatched right now.
      // lv_obj_delete_async() defers the teardown (and btn's own LV_EVENT_DELETE, which frees the
      // ssid String) via lv_async_call() to a period-0 timer that runs on the very next
      // lv_timer_handler() pass, entirely outside this call stack.
      if (scanModal) {
        lv_obj_add_flag(scanModal, LV_OBJ_FLAG_HIDDEN);
        lv_obj_delete_async(scanModal);
        scanModal = nullptr; scanList = nullptr; scanSpinner = nullptr;
      }
      // F9b step 3: build the keyboard only AFTER that teardown has run. 30ms at loop()'s ~5ms
      // cadence is several lv_timer_handler() passes, and the async delete's timer (period 0) is
      // serviced on the first of them, so the scan list's memory is back in the pool before the
      // keyboard asks for any. lv_timer_set_repeat_count(t, 1) makes it self-deleting after the
      // single run (lv_timer.c:347-369).
      kbPending = true;
      lv_timer_t *t = lv_timer_create(openKeyboardDeferred, 30, nullptr);
      if (t) lv_timer_set_repeat_count(t, 1);
      else { kbPending = false; openKeyboard(pendingSsid); } // pool too tight for a timer: degrade, don't wedge
    }, LV_EVENT_CLICKED, nullptr);
  }
}

// ---- saved networks list ----
static void rebuildSavedList() {
  lv_obj_clean(savedList);
  for (auto &c : wifi_mgr_saved()) {
    lv_obj_t *btn = lv_list_add_button(savedList, LV_SYMBOL_SAVE, c.ssid.c_str());
    lv_obj_set_style_text_color(btn, COL_TEXT, 0); // readability: pin row contrast on COL_CARD
    lv_obj_t *trash = lv_button_create(btn);
    lv_obj_t *tl = lv_label_create(trash);
    lv_label_set_text(tl, LV_SYMBOL_TRASH);
    lv_obj_align(trash, LV_ALIGN_RIGHT_MID, 0, 0);
    lv_obj_set_user_data(trash, new String(c.ssid));
    // Same ownership pattern as the scan-result buttons above: free exactly once, on delete.
    lv_obj_add_event_cb(trash, [](lv_event_t *e) {
      delete (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
    }, LV_EVENT_DELETE, nullptr);
    lv_obj_add_event_cb(trash, [](lv_event_t *e) {
      String *ssid = (String *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
      if (ssid) { wifi_mgr_forget(*ssid); rebuildSavedList(); } // NO delete here — DELETE owns it
    }, LV_EVENT_CLICKED, nullptr);
  }
  if (wifi_mgr_saved().empty()) {
    lv_obj_t *t = lv_list_add_text(savedList, "No saved networks - add one below");
    lv_obj_set_style_text_color(t, COL_MUTED, 0);
  }
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
