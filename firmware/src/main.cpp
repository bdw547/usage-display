#include <Arduino.h>
#include <lvgl.h>
#include "display.h"
#include "touch.h"
#include "lvgl_port.h"

static int taps = 0;

void setup() {
  Serial.begin(115200);
  display_init();
  touch_init();
  lvgl_port_init();

  lv_obj_set_style_bg_color(lv_screen_active(), lv_color_hex(0x101014), 0);
  lv_obj_t *label = lv_label_create(lv_screen_active());
  lv_label_set_text(label, "M3: LVGL alive");
  lv_obj_set_style_text_color(label, lv_color_hex(0xEDEDF2), 0);
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, 40);

  lv_obj_t *btn = lv_button_create(lv_screen_active());
  lv_obj_align(btn, LV_ALIGN_CENTER, 0, 60);
  lv_obj_t *btnLabel = lv_label_create(btn);
  lv_label_set_text(btnLabel, "tap me: 0");
  lv_obj_add_event_cb(btn, [](lv_event_t *e) {
    lv_label_set_text_fmt((lv_obj_t *)lv_event_get_user_data(e), "tap me: %d", ++taps);
    Serial.printf("taps=%d\n", taps);
  }, LV_EVENT_CLICKED, btnLabel);

  lv_obj_t *arc = lv_arc_create(lv_screen_active());
  lv_obj_set_size(arc, 150, 150);
  lv_obj_align(arc, LV_ALIGN_CENTER, 0, -100);
  lv_anim_t a;
  lv_anim_init(&a);
  lv_anim_set_var(&a, arc);
  lv_anim_set_values(&a, 0, 100);
  lv_anim_set_duration(&a, 2000);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&a, [](void *var, int32_t v) { lv_arc_set_value((lv_obj_t *)var, v); });
  lv_anim_start(&a);
  Serial.println("M3: ui built");
}

void loop() {
  lv_timer_handler();
  delay(5);
}
