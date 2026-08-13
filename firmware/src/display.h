// firmware/src/display.h
#pragma once
#include <Arduino_GFX_Library.h>
extern Arduino_RGB_Display *gfx;
void display_init();
void display_set_backlight(bool on);
