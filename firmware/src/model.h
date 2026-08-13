// firmware/src/model.h
#pragma once
#include <stdint.h>
#include <stddef.h>

struct Window { bool has = false; float pct = 0; int32_t resetsInSec = 0; bool hasReset = false; };
struct TokenBucket { int64_t in = 0, out = 0, cacheRead = 0, cacheWrite = 0, total = 0; };

struct UsageData {
  bool valid = false;
  uint32_t receivedAtMs = 0;      // millis() when parsed — freshness math adds elapsed time
  int machineCount = 0;
  // claude limits
  bool hasClaudeLimits = false; int32_t claudeLimitsAge = 0;
  Window session, weekly;
  struct { char label[16]; Window w; } extras[3]; int extraCount = 0;
  bool hasCredits = false; float creditsUsd = 0; // claude.limits.extraUsage.usedCreditsUsd
  // claude tokens
  bool hasTokens = false; int32_t tokensAge = 0;
  TokenBucket today, week, month, allTime;
  float costMonth = 0, costAllTime = 0;
  // codex
  bool hasCodex = false; int32_t codexAge = 0; Window cxFive, cxWeekly; char cxPlan[16] = "";
  // copilot
  bool hasCopilot = false; int32_t copilotAge = 0;
  int64_t cpUsed = 0, cpIncluded = 0; float cpPct = 0; int32_t cpResetsInSec = 0; bool cpHasReset = false; char cpPlan[16] = "";
};

// Formatting helpers (pure; shared by all screens)
void fmt_compact(int64_t n, char *out, size_t len);      // 1234 -> "1.2K", 12400000 -> "12.4M"
void fmt_cost(float usd, char *out, size_t len);         // 41.2 -> "$41.20"
void fmt_countdown(int32_t sec, char *out, size_t len);  // 8040 -> "2h 14m"; 275000 -> "3d 4h"; <=0 -> "now"
void fmt_age(int32_t sec, char *out, size_t len);        // 45 -> "45s"; 300 -> "5m"; ...
