// firmware/src/lvgl_port.cpp
#include <Arduino.h>
#include <lvgl.h>
#include <esp_heap_caps.h>
#include "lvgl_port.h"
#include "display.h"
#include "touch.h"
#include "board.h"

// Fix-ladder rung 2: draw buffers moved out of PSRAM into internal DMA-capable RAM so LVGL's
// own render/blit traffic stops contending with the RGB panel's PSRAM framebuffer DMA (rung 1,
// display.cpp). Halved from 80 to 40 lines (37.5KB/buffer instead of 75KB) to leave headroom for
// WiFi/TLS/task-stack allocations that land later in boot (net_start() et al).
static const size_t BUF_LINES = 40; // partial render buffer height

// Allocates a draw buffer preferring internal DMA-capable RAM; falls back to PSRAM (with a
// warning) rather than halting outright, since a PSRAM buffer is still strictly better than no
// UI at all — halting is reserved for the case where NEITHER pool can satisfy the request.
static uint8_t *allocDrawBuffer(size_t buf_bytes, const char *tag) {
  uint8_t *p = (uint8_t *)heap_caps_malloc(buf_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
  if (p) return p;
  Serial.printf("WARN: %s internal-DMA alloc failed (%u bytes) - falling back to PSRAM\n", tag, (unsigned)buf_bytes);
  p = (uint8_t *)heap_caps_malloc(buf_bytes, MALLOC_CAP_SPIRAM);
  if (!p) Serial.printf("FATAL: %s PSRAM fallback also failed (%u bytes)\n", tag, (unsigned)buf_bytes);
  return p;
}

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
  uint8_t *buf1 = allocDrawBuffer(buf_bytes, "lvgl buf1");
  uint8_t *buf2 = allocDrawBuffer(buf_bytes, "lvgl buf2");
  if (!buf1 || !buf2) {
    Serial.println("FATAL: LVGL draw buffer allocation failed in both internal and PSRAM pools");
    while (true) delay(1000);
  }

  lv_display_t *disp = lv_display_create(SCREEN_W, SCREEN_H);
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  lv_display_set_flush_cb(disp, flush_cb);
  lv_display_set_buffers(disp, buf1, buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);

  // Readability fix (user hardware finding): every STOCK LVGL widget — lv_list rows, lv_keyboard,
  // lv_textarea, the scan spinner, the modal containers' borders — was drawing in the default
  // LIGHT theme (white panels, pale key glyphs) inside our hand-styled dark UI. lv_display_create()
  // auto-inits the default theme (lv_display.c) using LV_THEME_DEFAULT_DARK, so the fix is systemic:
  // re-init it in dark mode here, before ui_init() builds a single widget, instead of patching each
  // widget's styles one at a time.
  //   - lv_theme_default_init() keeps ONE global theme struct, so this re-initializes the very theme
  //     the display is already pointing at, then calls lv_obj_report_style_change() itself.
  //   - font is &lv_font_montserrat_14 == LV_FONT_DEFAULT, i.e. exactly what the auto-init used, so
  //     no metrics change anywhere (our own screens set their fonts explicitly regardless).
  //   - REGRESSION GUARD: every widget on the custom screens (status bar, arcs, bars, token cards,
  //     dots, banner, tile backgrounds) sets its own bg/arc/text colors and zero border widths, so a
  //     theme swap cannot repaint them; only theme-defaulted stock widgets change.
  // lv_conf.h's LV_THEME_DEFAULT_DARK is flipped to 1 as well, so even the auto-init is dark and the
  // light palette is never built; this call additionally sets the accent colors, which lv_conf can't.
  lv_theme_t *th = lv_theme_default_init(disp,
                                         lv_color_hex(0x4A90D9) /* primary: our blue action buttons */,
                                         lv_color_hex(0xD97757) /* secondary: claude coral */,
                                         true /* dark */, &lv_font_montserrat_14);
  lv_display_set_theme(disp, th);

  lv_indev_t *indev = lv_indev_create();
  lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(indev, touchpad_read_cb);
}
