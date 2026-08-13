// firmware/src/model.cpp
#include "model.h"
#include <stdio.h>
#include <stdlib.h>

void fmt_compact(int64_t n, char *out, size_t len) {
  double v = (double)n;
  if (n < 1000) snprintf(out, len, "%lld", (long long)n);
  else if (n < 1000000) snprintf(out, len, "%.1fK", v / 1e3);
  else if (n < 1000000000LL) snprintf(out, len, "%.1fM", v / 1e6);
  else snprintf(out, len, "%.2fB", v / 1e9);
}

void fmt_cost(float usd, char *out, size_t len) {
  if (usd >= 1000) snprintf(out, len, "$%.0f", usd);
  else snprintf(out, len, "$%.2f", usd);
}

void fmt_countdown(int32_t sec, char *out, size_t len) {
  if (sec <= 0) { snprintf(out, len, "now"); return; }
  int32_t d = sec / 86400, h = (sec % 86400) / 3600, m = (sec % 3600) / 60;
  if (d > 0) snprintf(out, len, "%dd %dh", d, h);
  else if (h > 0) snprintf(out, len, "%dh %dm", h, m);
  else snprintf(out, len, "%dm", m > 0 ? m : 1);
}

void fmt_age(int32_t sec, char *out, size_t len) {
  if (sec < 0) { snprintf(out, len, "--"); return; }
  if (sec < 90) snprintf(out, len, "%lds", (long)sec);
  else if (sec < 5400) snprintf(out, len, "%ldm", (long)(sec / 60));
  else if (sec < 129600) snprintf(out, len, "%ldh", (long)(sec / 3600));
  else snprintf(out, len, "%ldd", (long)(sec / 86400));
}
