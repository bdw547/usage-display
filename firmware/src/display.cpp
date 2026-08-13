// firmware/src/display.cpp
#include "display.h"
#include "board.h"
#include <esp_lcd_panel_rgb.h>

// ============================================================================================
// F10 EMPIRICAL TUNING LADDER — the two numbers below are the whole knob set. Change these, not
// the call site. The user judges each variant visually (idle shimmer + scan-time glitch); the
// winning combination gets recorded here and in firmware/README.md.
//
//   Variant   BOUNCE_LINES   PCLK_HZ     Rationale / verdict
//   --------  -------------  ----------  -----------------------------------------------------
//   round-1        10        12,000,000  original bounce; fixed the gross full-redraw glitch
//   round-2        20        12,000,000  raised to ride through WiFi-scan radio bursts; the
//                                        user's 2nd power-cycle photo showed SUSTAINED idle
//                                        striping/shimmer, i.e. round-2 made steady-state
//                                        refill timing WORSE than round-1
//   >>> A <<<      10        12,000,000  bounce back to round-1 size, keeping the F10 structural
//                                        fixes (boot stagger + post-boot panel restart). FLASHED.
//   B               8        14,000,000  if A still shimmers: smaller bounce, faster pclk (more
//                                        refill headroom per DMA burst, shorter burst)
//   C              10        10,000,000  if B fails: round-1 bounce, slower pclk (less bandwidth
//                                        demanded per line)
//
// Mechanics, for whoever turns this next: the esp_lcd_rgb driver DMA-refills a small internal-SRAM
// bounce buffer from the PSRAM framebuffer, so the panel's continuous pixel clock never reads PSRAM
// directly. A refill that loses the race against PSRAM contention (LVGL flush traffic, WiFi/TLS)
// underruns: too little slack and single lines shimmer; a bad enough underrun desyncs scanout
// entirely (the vertically-wrapped boot image). Bigger bounce = more slack per burst but a longer,
// heavier burst; the two effects trade off non-monotonically, which is why this is a ladder walked
// on hardware rather than a formula.
// ============================================================================================
static const size_t BOUNCE_LINES = 10;            // Variant A
static const int32_t PCLK_HZ = 12000000;          // Variant A

// F10(b): one-shot post-boot scanout re-sync, ~3s in — after the boot burst (WiFi association,
// first TLS handshake, first full LVGL render) has passed. esp_lcd_rgb_panel_restart() is the
// canonical recovery for "LCD controller out of sync with the DMA because of insufficient
// bandwidth" (esp_lcd_panel_rgb.h:221-236); it only sets a flag, and the next VSYNC interrupt does
// the actual DMA restart, so it is safe to call from loop().
static const uint32_t PANEL_RESYNC_AT_MS = 3000;

Arduino_RGB_Display *gfx = nullptr;
static Arduino_ESP32RGBPanel *rgbpanel = nullptr;
static bool bootResyncDone = false;

// ---------------------------------------------------------------------------------------------
// GFX 1.6.7 keeps the esp_lcd panel handle in a PRIVATE member with no accessor:
//   .pio/libdeps/guition4848s040/GFX Library for Arduino/src/databus/Arduino_ESP32RGBPanel.h:146
//     esp_lcd_panel_handle_t _panel_handle = NULL;
// (set inside getFrameBuffer(), which Arduino_RGB_Display::begin() calls). Subclassing can't reach
// a private member, and patching .pio/libdeps would be silently undone by the next `pio pkg`
// install since that tree is generated and gitignored. So: the standard explicit-instantiation
// access idiom. [temp.spec]/6 says access checks are NOT performed on the template arguments of an
// explicit instantiation, so naming &Arduino_ESP32RGBPanel::_panel_handle here is well-formed,
// standard C++ — not a `#define private public` hack — and it needs zero library modification.
// If a future GFX release renames or removes the member this fails at COMPILE time, loudly.
// ---------------------------------------------------------------------------------------------
namespace {
struct PanelHandleTag {
  typedef esp_lcd_panel_handle_t Arduino_ESP32RGBPanel::*MemberPtr;
  friend MemberPtr panelHandleMember(PanelHandleTag);
};
template <typename Tag, typename Tag::MemberPtr M>
struct PanelHandleThief {
  friend typename Tag::MemberPtr panelHandleMember(Tag) { return M; }
};
template struct PanelHandleThief<PanelHandleTag, &Arduino_ESP32RGBPanel::_panel_handle>;

esp_lcd_panel_handle_t panelHandle() {
  if (!rgbpanel) return nullptr;
  return rgbpanel->*panelHandleMember(PanelHandleTag());
}
} // namespace

void display_init() {
  // 3-wire software SPI carries the ST7701S init sequence; pixels go over RGB.
  Arduino_DataBus *bus = new Arduino_SWSPI(
      GFX_NOT_DEFINED /* DC */, PIN_LCD_CS, PIN_LCD_SCK, PIN_LCD_MOSI, GFX_NOT_DEFINED /* MISO */);

  rgbpanel = new Arduino_ESP32RGBPanel(
      PIN_LCD_DE, PIN_LCD_VSYNC, PIN_LCD_HSYNC, PIN_LCD_PCLK,
      PIN_LCD_R0, PIN_LCD_R1, PIN_LCD_R2, PIN_LCD_R3, PIN_LCD_R4,
      PIN_LCD_G0, PIN_LCD_G1, PIN_LCD_G2, PIN_LCD_G3, PIN_LCD_G4, PIN_LCD_G5,
      PIN_LCD_B0, PIN_LCD_B1, PIN_LCD_B2, PIN_LCD_B3, PIN_LCD_B4,
      1 /* hsync_polarity */, 10 /* hsync_front_porch */, 8 /* hsync_pulse_width */, 50 /* hsync_back_porch */,
      1 /* vsync_polarity */, 10 /* vsync_front_porch */, 8 /* vsync_pulse_width */, 20 /* vsync_back_porch */,
      1 /* pclk_active_neg */, PCLK_HZ /* prefer_speed — ladder knob, see table above */,
      false /* useBigEndian */, 0 /* de_idle_high */, 0 /* pclk_idle_high */,
      SCREEN_W * BOUNCE_LINES /* bounce_buffer_size_px — ladder knob, see table above. If the
                  internal-DMA allocation can't be satisfied, esp_lcd_new_rgb_panel fails through
                  ESP_ERROR_CHECK very early in boot: visible on serial as a panel-init abort, not
                  a silent hang. */);

  gfx = new Arduino_RGB_Display(SCREEN_W, SCREEN_H, rgbpanel, 0 /* rotation */, true /* auto_flush */,
                                bus, GFX_NOT_DEFINED /* RST */,
                                st7701_type9_init_operations, sizeof(st7701_type9_init_operations));
  gfx->begin(); // allocates the PSRAM framebuffer and creates the esp_lcd panel (handle valid after this)
  display_set_backlight(true);
  Serial.printf("display: bounce=%u px (%u lines) pclk=%ld Hz panel=%p\n",
                (unsigned)(SCREEN_W * BOUNCE_LINES), (unsigned)BOUNCE_LINES, (long)PCLK_HZ, panelHandle());
}

void display_set_backlight(bool on) {
  pinMode(PIN_LCD_BL, OUTPUT);
  digitalWrite(PIN_LCD_BL, on ? HIGH : LOW);
}

// F10(b). Realigns panel scanout with the DMA regardless of what starved it — the fix for the
// user's "header at the bottom / image vertically wrapped" power-cycle repro, which no amount of
// redrawing corrects because the shift lives in the panel's scan position, not the framebuffer.
bool display_panel_resync() {
  esp_lcd_panel_handle_t h = panelHandle();
  if (!h) { Serial.println("display: resync skipped - no panel handle"); return false; }
  esp_err_t err = esp_lcd_rgb_panel_restart(h);
  Serial.printf("display: panel resync -> %s\n", esp_err_to_name(err));
  return err == ESP_OK;
}

void display_boot_resync_tick() {
  if (bootResyncDone || millis() < PANEL_RESYNC_AT_MS) return;
  bootResyncDone = true;
  display_panel_resync();
}
