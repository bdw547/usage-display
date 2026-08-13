// firmware/include/board.h — Guition ESP32-4848S040C_I pin map.
// Verified against the ESPHome community config for this board.
#pragma once

// ST7701S init bus (3-wire SPI, bit-banged)
#define PIN_LCD_CS    39
#define PIN_LCD_SCK   48
#define PIN_LCD_MOSI  47

// 16-bit parallel RGB
#define PIN_LCD_DE    18
#define PIN_LCD_VSYNC 17
#define PIN_LCD_HSYNC 16
#define PIN_LCD_PCLK  21
#define PIN_LCD_R0    11
#define PIN_LCD_R1    12
#define PIN_LCD_R2    13
#define PIN_LCD_R3    14
#define PIN_LCD_R4    0
#define PIN_LCD_G0    8
#define PIN_LCD_G1    20
#define PIN_LCD_G2    3
#define PIN_LCD_G3    46
#define PIN_LCD_G4    9
#define PIN_LCD_G5    10
#define PIN_LCD_B0    4
#define PIN_LCD_B1    5
#define PIN_LCD_B2    6
#define PIN_LCD_B3    7
#define PIN_LCD_B4    15

#define PIN_LCD_BL    38   // backlight, active high

// GT911 capacitive touch (INT/RST not wired on this board)
#define PIN_TOUCH_SDA 19
#define PIN_TOUCH_SCL 45

#define SCREEN_W 480
#define SCREEN_H 480
