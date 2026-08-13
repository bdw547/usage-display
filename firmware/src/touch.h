// firmware/src/touch.h
#pragma once
#include <stdint.h>
bool touch_init();
bool touch_read(int16_t &x, int16_t &y);
