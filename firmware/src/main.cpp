#include <Arduino.h>
#include "board.h"
#include "display.h"
#include "touch.h"

void setup() {
  Serial.begin(115200);
  display_init();
  gfx->fillScreen(RGB565_BLACK);
  gfx->setTextColor(RGB565_WHITE); gfx->setTextSize(2);
  gfx->setCursor(120, 230); gfx->print("M2: touch me anywhere");
  Serial.printf("M2: touch_init %s\n", touch_init() ? "OK" : "FAILED");
}

void loop() {
  int16_t x, y;
  if (touch_read(x, y)) {
    gfx->fillCircle(x, y, 4, RGB565_CYAN);
    Serial.printf("touch %d,%d\n", x, y);
  }
  delay(10);
}
