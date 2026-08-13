// firmware/src/touch.cpp
#include "touch.h"
#include <bb_captouch.h>
#include "board.h"

static BBCapTouch bbct;

bool touch_init() {
  // INT/RST are not wired on this board; bb_captouch supports -1 for both.
  int rc = bbct.init(PIN_TOUCH_SDA, PIN_TOUCH_SCL, -1 /* RST */, -1 /* INT */);
  return rc == CT_SUCCESS;
}

bool touch_read(int16_t &x, int16_t &y) {
  TOUCHINFO ti;
  if (bbct.getSamples(&ti) && ti.count > 0) {
    x = ti.x[0];
    y = ti.y[0];
    return true;
  }
  return false;
}
