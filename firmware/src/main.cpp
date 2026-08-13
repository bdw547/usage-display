#include <Arduino.h>
#include <lvgl.h>
#include "board.h"
#include "display.h"
#include "touch.h"
#include "lvgl_port.h"
#include "wifi_mgr.h"
#include "net.h"
#include "ui/ui.h"

static uint32_t lastSecond = 0;

void setup() {
  Serial.begin(115200);
  display_init();
  touch_init();
  lvgl_port_init();
  wifi_mgr_init();
  ui_init();
  // F9c: report BOTH heaps. The LVGL pool is a static internal-RAM array (now 64KB, F9a) that is
  // already subtracted from the internal free figure, so print its own occupancy alongside —
  // that's the number the frozen-keyboard bug was really about.
  lv_mem_monitor_t mon;
  lv_mem_monitor(&mon);
  Serial.printf("heap: internal=%u psram=%u | lvgl pool: total=%u free=%u biggest=%u used=%u%%\n",
                ESP.getFreeHeap(), ESP.getFreePsram(), (unsigned)mon.total_size,
                (unsigned)mon.free_size, (unsigned)mon.free_biggest_size, (unsigned)mon.used_pct);
  net_start();
  if (!wifi_mgr_has_saved()) { ui_goto_settings(); ui_set_swipe_enabled(false); } // first boot: land on setup, lock swipe until a network is saved
  Serial.println("boot complete");
}

void loop() {
  lv_timer_handler();
  display_boot_resync_tick(); // F10(b): one-shot RGB scanout re-sync ~3s after boot
  wifi_mgr_tick();
  UsageData u;
  if (net_take_update(u)) ui_apply(u);
  if (millis() - lastSecond >= 1000) { lastSecond = millis(); ui_tick_1s(); }
  delay(5);
}
