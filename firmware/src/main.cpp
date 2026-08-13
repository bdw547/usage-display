#include <Arduino.h>
#include "board.h"

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LCD_BL, OUTPUT);
  digitalWrite(PIN_LCD_BL, LOW); // keep panel dark until display bring-up
}

void loop() {
  Serial.printf("alive uptime=%lus psram=%u flash=%u\n", millis() / 1000,
                ESP.getPsramSize(), ESP.getFlashChipSize());
  delay(2000);
}
