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
  net_start();
  if (!wifi_mgr_has_saved()) ui_goto_settings(); // first boot: land on setup
  Serial.println("boot complete");
}

void loop() {
  lv_timer_handler();
  wifi_mgr_tick();
  UsageData u;
  if (net_take_update(u)) ui_apply(u);
  if (millis() - lastSecond >= 1000) { lastSecond = millis(); ui_tick_1s(); }
  delay(5);
}
