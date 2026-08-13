// firmware/src/lvgl_port.cpp
#include <Arduino.h>
#include <lvgl.h>
#include <esp_heap_caps.h>
#include "lvgl_port.h"
#include "display.h"
#include "touch.h"
#include "board.h"

static const size_t BUF_LINES = 80; // partial render buffer height

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
  int32_t w = area->x2 - area->x1 + 1;
  int32_t h = area->y2 - area->y1 + 1;
  gfx->draw16bitRGBBitmap(area->x1, area->y1, (uint16_t *)px_map, w, h);
  lv_display_flush_ready(disp);
}

static void touchpad_read_cb(lv_indev_t *indev, lv_indev_data_t *data) {
  int16_t x, y;
  if (touch_read(x, y)) {
    data->state = LV_INDEV_STATE_PRESSED;
    data->point.x = x;
    data->point.y = y;
  } else {
    data->state = LV_INDEV_STATE_RELEASED;
  }
}

void lvgl_port_init() {
  lv_init();
  lv_tick_set_cb([]() -> uint32_t { return millis(); });

  size_t buf_bytes = SCREEN_W * BUF_LINES * sizeof(uint16_t);
  uint8_t *buf1 = (uint8_t *)heap_caps_malloc(buf_bytes, MALLOC_CAP_SPIRAM);
  uint8_t *buf2 = (uint8_t *)heap_caps_malloc(buf_bytes, MALLOC_CAP_SPIRAM);

  lv_display_t *disp = lv_display_create(SCREEN_W, SCREEN_H);
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  lv_display_set_flush_cb(disp, flush_cb);
  lv_display_set_buffers(disp, buf1, buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);

  lv_indev_t *indev = lv_indev_create();
  lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(indev, touchpad_read_cb);
}
