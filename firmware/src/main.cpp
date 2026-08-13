#include <Arduino.h>
#include "board.h"
#include "display.h"

void setup() {
  Serial.begin(115200);
  display_init();
  gfx->fillScreen(RGB565_BLACK);
  gfx->fillRect(0, 0, 240, 240, RGB565_RED);
  gfx->fillRect(240, 0, 240, 240, RGB565_GREEN);
  gfx->fillRect(0, 240, 240, 240, RGB565_BLUE);
  gfx->fillRect(240, 240, 240, 240, RGB565_WHITE);
  gfx->setTextColor(RGB565_BLACK); gfx->setTextSize(3);
  gfx->setCursor(280, 350); gfx->print("M1 OK");
  Serial.println("M1: test pattern drawn");
}

void loop() { delay(1000); }
