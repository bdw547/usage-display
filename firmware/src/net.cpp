// firmware/src/net.cpp
#include "net.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "wifi_mgr.h"
#include "secrets.h"
#include "certs.h"

static SemaphoreHandle_t mutex;
static UsageData shared;
static bool dirty = false;
static volatile NetStatus status = NetStatus::NEVER;
static volatile uint32_t lastOkMs = 0;

static const uint32_t POLL_MS = 20000;

static void parseWindow(JsonVariantConst v, Window &w) {
  w.has = !v.isNull();
  if (!w.has) return;
  // F7: the window object can exist with a null pct (merge.js emits `pct: null` rather than
  // dropping the window). Track that separately instead of letting `| 0.0f` invent a 0% reading.
  w.hasPct = !v["pct"].isNull();
  w.pct = v["pct"] | 0.0f;
  w.hasReset = !v["resetsInSec"].isNull();
  w.resetsInSec = v["resetsInSec"] | 0;
}

static void parseBucket(JsonVariantConst v, TokenBucket &b) {
  b.in = v["in"] | 0LL; b.out = v["out"] | 0LL;
  b.cacheRead = v["cacheRead"] | 0LL; b.cacheWrite = v["cacheWrite"] | 0LL;
  b.total = v["total"] | 0LL;
}

static bool parseSummary(const String &body, UsageData &u) {
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok) return false;
  if ((doc["v"] | 0) != 1) return false;
  u = UsageData{};
  u.valid = true;
  u.receivedAtMs = millis();
  u.machineCount = doc["machines"].as<JsonArrayConst>().size();

  JsonVariantConst cl = doc["claude"]["limits"];
  if (!cl.isNull()) {
    u.hasClaudeLimits = true;
    u.claudeLimitsAge = cl["ageSec"] | 0;
    parseWindow(cl["session"], u.session);
    parseWindow(cl["weekly"], u.weekly);
    for (JsonObjectConst e : cl["extra"].as<JsonArrayConst>()) {
      if (u.extraCount >= 3) break;
      auto &slot = u.extras[u.extraCount];
      snprintf(slot.label, sizeof(slot.label), "%s", (const char *)(e["label"] | "other"));
      parseWindow(e, slot.w);
      u.extraCount++;
    }
    // Not sent by the relay yet (separate task lands it) — tolerate absence: chained [] on a
    // missing key yields a null JsonVariantConst, so this stays false/0 rather than throwing.
    JsonVariantConst credits = cl["extraUsage"]["usedCreditsUsd"];
    u.hasCredits = !credits.isNull();
    u.creditsUsd = credits | 0.0f;
  }
  JsonVariantConst tk = doc["claude"]["tokens"];
  if (!tk.isNull()) {
    u.hasTokens = true;
    u.tokensAge = tk["ageSec"] | 0;
    parseBucket(tk["today"], u.today); parseBucket(tk["week"], u.week);
    parseBucket(tk["month"], u.month); parseBucket(tk["allTime"], u.allTime);
    u.costMonth = tk["costUsd"]["month"] | 0.0f;
    u.costAllTime = tk["costUsd"]["allTime"] | 0.0f;
  }
  JsonVariantConst cx = doc["codex"]["limits"];
  if (!cx.isNull()) {
    u.hasCodex = true;
    u.codexAge = cx["ageSec"] | 0;
    parseWindow(cx["fiveHour"], u.cxFive);
    parseWindow(cx["weekly"], u.cxWeekly);
    snprintf(u.cxPlan, sizeof(u.cxPlan), "%s", (const char *)(cx["plan"] | ""));
  }
  JsonVariantConst cp = doc["copilot"]["quota"];
  if (!cp.isNull()) {
    u.hasCopilot = true;
    u.copilotAge = cp["ageSec"] | 0;
    // F7: `used`, `included` and `pctUsed` are all forwarded as explicit nulls by the relay when
    // the vendor omits them (merge.js `cp.used ?? null`). `included: null` is doubly ambiguous —
    // the collector uses it BOTH for a genuinely unlimited plan and for "the entitlement field was
    // missing" — so the firmware must not translate it into "(unlimited)". Presence flags here,
    // rendering decisions in screens.cpp.
    JsonVariantConst cpUsedV = cp["used"], cpInclV = cp["included"], cpPctV = cp["pctUsed"];
    u.cpHasUsed = !cpUsedV.isNull();
    u.cpUsed = u.cpHasUsed ? (cpUsedV | 0LL) : -1LL;
    u.cpHasIncluded = !cpInclV.isNull();
    u.cpIncluded = u.cpHasIncluded ? (cpInclV | 0LL) : -1LL;
    u.cpHasPct = !cpPctV.isNull();
    u.cpPct = cpPctV | 0.0f;
    u.cpHasReset = !cp["resetsInSec"].isNull();
    u.cpResetsInSec = cp["resetsInSec"] | 0;
    snprintf(u.cpPlan, sizeof(u.cpPlan), "%s", (const char *)(cp["plan"] | ""));
  }
  return true;
}

// F10(a): stagger the boot load. The RGB panel's bounce-buffer refill has to win a race against
// PSRAM contention every line; during the boot burst it was competing with WiFi association, the
// first TLS handshake (a 16KB+ mbedTLS allocation and a lot of crypto) and the first full-screen
// LVGL render ALL at once — the underrun that desyncs scanout (the user's "header at the bottom"
// power-cycle repro). Letting the UI and WiFi settle first costs one poll interval of latency at
// boot and nothing at all afterwards.
static const uint32_t BOOT_STAGGER_MS = 2500;

static void netTask(void *) {
  vTaskDelay(pdMS_TO_TICKS(BOOT_STAGGER_MS));
  for (;;) {
    if (wifi_mgr_state() != WifiState::CONNECTED) {
      if (status != NetStatus::NEVER) status = NetStatus::WIFI_DOWN;
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    {
      WiFiClientSecure client;
      client.setCACert(RELAY_ROOT_CAS);
      HTTPClient http;
      http.setTimeout(12000);
      http.setConnectTimeout(8000);
      if (http.begin(client, String(RELAY_URL) + "/v1/summary")) {
        http.addHeader("Authorization", String("Bearer ") + RELAY_READ_TOKEN);
        int code = http.GET();
        if (code == 200) {
          UsageData fresh;
          if (parseSummary(http.getString(), fresh)) {
            xSemaphoreTake(mutex, portMAX_DELAY);
            shared = fresh;
            dirty = true;
            xSemaphoreGive(mutex);
            status = NetStatus::OK;
            lastOkMs = millis();
          } else {
            status = NetStatus::PARSE_ERROR;
          }
        } else if (code == 401) {
          status = NetStatus::AUTH_ERROR;
        } else {
          status = NetStatus::HTTP_ERROR;
        }
        http.end();
      } else {
        status = NetStatus::HTTP_ERROR;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(POLL_MS));
  }
}

void net_start() {
  mutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(netTask, "net", 16384, nullptr, 1, nullptr, 0); // core 0; LVGL stays on core 1
}

bool net_take_update(UsageData &out) {
  bool got = false;
  xSemaphoreTake(mutex, portMAX_DELAY);
  if (dirty) { out = shared; dirty = false; got = true; }
  xSemaphoreGive(mutex);
  return got;
}

NetStatus net_status() { return status; }
uint32_t net_last_ok_ms() { return lastOkMs; }
