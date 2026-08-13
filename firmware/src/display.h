// firmware/src/display.h
#pragma once
#include <Arduino_GFX_Library.h>
extern Arduino_RGB_Display *gfx;
void display_init();
void display_set_backlight(bool on);
// F10(b): RGB-panel scanout re-sync (esp_lcd_rgb_panel_restart). Returns false if the panel handle
// couldn't be reached. display_boot_resync_tick() is the one-shot post-boot call; drive it from loop().
bool display_panel_resync();
void display_boot_resync_tick();
