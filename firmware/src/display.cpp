// firmware/src/display.cpp
#include "display.h"
#include "board.h"

Arduino_RGB_Display *gfx = nullptr;

void display_init() {
  // 3-wire software SPI carries the ST7701S init sequence; pixels go over RGB.
  Arduino_DataBus *bus = new Arduino_SWSPI(
      GFX_NOT_DEFINED /* DC */, PIN_LCD_CS, PIN_LCD_SCK, PIN_LCD_MOSI, GFX_NOT_DEFINED /* MISO */);

  Arduino_ESP32RGBPanel *rgbpanel = new Arduino_ESP32RGBPanel(
      PIN_LCD_DE, PIN_LCD_VSYNC, PIN_LCD_HSYNC, PIN_LCD_PCLK,
      PIN_LCD_R0, PIN_LCD_R1, PIN_LCD_R2, PIN_LCD_R3, PIN_LCD_R4,
      PIN_LCD_G0, PIN_LCD_G1, PIN_LCD_G2, PIN_LCD_G3, PIN_LCD_G4, PIN_LCD_G5,
      PIN_LCD_B0, PIN_LCD_B1, PIN_LCD_B2, PIN_LCD_B3, PIN_LCD_B4,
      1 /* hsync_polarity */, 10 /* hsync_front_porch */, 8 /* hsync_pulse_width */, 50 /* hsync_back_porch */,
      1 /* vsync_polarity */, 10 /* vsync_front_porch */, 8 /* vsync_pulse_width */, 20 /* vsync_back_porch */,
      1 /* pclk_active_neg */, 12000000 /* prefer_speed: 12MHz, matches the ESPHome community config for this panel */,
      false /* useBigEndian */, 0 /* de_idle_high */, 0 /* pclk_idle_high */,
      480 * 10 /* bounce_buffer_size_px: fix-ladder rung 1 — a small internal-SRAM bounce
                  buffer the esp_lcd_rgb driver DMA-refills from the PSRAM framebuffer, so the
                  panel's continuous pixel-clock DMA stops contending directly with PSRAM against
                  LVGL's own render/flush traffic. Full-UI redraw load exposed this; M3's plain
                  test-pattern load didn't. Paired with rung 2 in lvgl_port.cpp (below). */);
      // Fix-ladder rung 1 applied above (pclk_active_neg=1, prefer_speed=12MHz, bounce buffer) to
      // address RGB-panel/PSRAM-contention glitching seen on hardware under real UI redraw load.
      // Rung 3 (only if still glitchy after rungs 1+2): drop prefer_speed to 10000000.

  gfx = new Arduino_RGB_Display(SCREEN_W, SCREEN_H, rgbpanel, 0 /* rotation */, true /* auto_flush */,
                                bus, GFX_NOT_DEFINED /* RST */,
                                st7701_type9_init_operations, sizeof(st7701_type9_init_operations));
  gfx->begin();
  display_set_backlight(true);
}

void display_set_backlight(bool on) {
  pinMode(PIN_LCD_BL, OUTPUT);
  digitalWrite(PIN_LCD_BL, on ? HIGH : LOW);
}
