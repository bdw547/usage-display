// firmware/src/wifi_mgr.cpp
#include "wifi_mgr.h"
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "secrets.h"

static Preferences prefs;
static std::vector<WifiCred> creds;

// Final-review F3: `state` is read from netTask (core 0, net.cpp) and from the UI, and used to be
// written from THREE contexts (the arduino_events task, the loop task's tick, and the UI helpers).
// It is now written only from loop-task code (wifi_mgr_tick / connect_to / forget / scan_done); the
// event callback below just raises volatile flags that tick() consumes. `volatile` keeps the
// cross-core reader (netTask's gate at net.cpp) from caching it in a register across its poll loop.
static volatile WifiState state = WifiState::IDLE;
static String targetSsid;
static volatile uint32_t stateSince = 0;
static volatile uint32_t nextActionAt = 0;
static bool uiScanPending = false;
static uint32_t uiScanStartedAt = 0;

// Final-review F3: set ONLY by the WiFi event callback (arduino_events task), cleared only by
// wifi_mgr_tick() on the loop task. Nothing else about the state machine is touched from the event
// context, so there is no read-modify-write to race on — a missed edge costs at most one tick.
static volatile bool evGotIp = false;
static volatile bool evDisconnected = false;

static const uint32_t CONNECT_TIMEOUT_MS = 15000;
static const uint32_t RESCAN_INTERVAL_MS = 30000;
static const uint32_t SCAN_TIMEOUT_MS = 20000;   // F5 belt-and-braces: SCANNING can't outlive this
static const uint32_t UI_SCAN_TIMEOUT_MS = 20000;
static const size_t MAX_NETWORKS = 8;

// Final-review F4: per-SSID consecutive connect failures. Three timed-out CONNECTING attempts on
// one SSID park it for BLOCK_MS so the scan picker moves on to a weaker-but-working saved network
// instead of retrying a mistyped password forever (the old behaviour looped ~20s/cycle for ever).
// RAM-only and deliberately so: a power cycle or a successful connect is a clean slate.
static const uint8_t MAX_FAILS = 3;
static const uint32_t BLOCK_MS = 5 * 60 * 1000;
struct SsidFailure { String ssid; uint8_t fails; uint32_t blockedUntil; };
static std::vector<SsidFailure> failures;

static SsidFailure *findFailure(const String &ssid) {
  for (auto &f : failures) if (f.ssid == ssid) return &f;
  return nullptr;
}

// Signed-delta comparison so a millis() rollover (49.7 days) can't leave an SSID blocked forever.
static bool ssidBlocked(const String &ssid, uint32_t now) {
  SsidFailure *f = findFailure(ssid);
  return f && f->blockedUntil && (int32_t)(now - f->blockedUntil) < 0;
}

static void noteConnectFailure(const String &ssid, uint32_t now) {
  if (ssid.isEmpty()) return;
  SsidFailure *f = findFailure(ssid);
  if (!f) { failures.push_back({ssid, 0, 0}); f = &failures.back(); }
  if (f->fails < 255) f->fails++;
  if (f->fails >= MAX_FAILS) {
    f->fails = 0;
    f->blockedUntil = now + BLOCK_MS;
    if (f->blockedUntil == 0) f->blockedUntil = 1; // 0 is the "not blocked" sentinel
    Serial.printf("wifi: %s failed %u times - skipping it for %lus\n", ssid.c_str(),
                  (unsigned)MAX_FAILS, (unsigned long)(BLOCK_MS / 1000));
  }
}

static void clearFailures(const String &ssid) {
  SsidFailure *f = findFailure(ssid);
  if (f) { f->fails = 0; f->blockedUntil = 0; }
}

static void persist() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (auto &c : creds) { JsonObject o = arr.add<JsonObject>(); o["s"] = c.ssid; o["p"] = c.pass; }
  String out; serializeJson(doc, out);
  prefs.putString("list", out);
}

static void loadCreds() {
  creds.clear();
  String raw = prefs.getString("list", "[]");
  JsonDocument doc;
  if (deserializeJson(doc, raw) == DeserializationError::Ok) {
    for (JsonObject o : doc.as<JsonArray>()) creds.push_back({o["s"].as<String>(), o["p"].as<String>()});
  }
#ifdef DEV_WIFI_SSID
  bool have = false;
  for (auto &c : creds) if (c.ssid == DEV_WIFI_SSID) have = true;
  if (!have) {
    creds.insert(creds.begin(), {DEV_WIFI_SSID, DEV_WIFI_PASS});
    while (creds.size() > MAX_NETWORKS) creds.pop_back();
    persist();
  }
#endif
}

static void setState(WifiState s) { state = s; stateSince = millis(); }

static void startScan() {
  // F2: no explicit scanDelete() here. WiFiScanClass::scanNetworks() already early-outs with
  // WIFI_SCAN_RUNNING when a scan is in flight (WiFiScan.cpp:69) and calls scanDelete() itself
  // otherwise (:77) — deleting first is what used to let this path destroy the results the UI scan
  // (or this scan) was about to read. If a UI-requested scan is already running we simply adopt it.
  int16_t r = WiFi.scanNetworks(true /* async */);
  if (r == WIFI_SCAN_FAILED) {
    // F5: the radio refused to start a scan (esp_wifi_scan_start returns ESP_ERR_WIFI_STATE when
    // it is mid-connect/mid-disconnect, which is exactly where the OFFLINE branch calls us from).
    // Don't enter SCANNING — scanComplete() would return -2 for ever and the machine would wedge.
    setState(WifiState::OFFLINE);
    nextActionAt = millis() + 5000;
    return;
  }
  setState(WifiState::SCANNING);
}

void wifi_mgr_init() {
  prefs.begin("wifinet", false);
  loadCreds();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // the state machine owns reconnects
  // Final-review F3: flags only. No setState(), no nextActionAt, and crucially no configTzTime()
  // (which stops/restarts the lwIP SNTP client and does setenv/tzset) from the event task.
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t) {
    if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) evGotIp = true;
    else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) evDisconnected = true;
  });
  if (!creds.empty()) startScan(); else setState(WifiState::OFFLINE);
}

void wifi_mgr_tick() {
  uint32_t now = millis();

  // ---- F3: consume the event flags on the loop task, where every other writer lives ----
  if (evGotIp) {
    evGotIp = false;
    // R1: do NOT clear evDisconnected here. The two flags can be raised in either order within one
    // tick, and clearing the disconnect on the strength of a GOT_IP throws away a REAL drop that
    // landed after the association. The asymmetry is what matters: a spurious extra disconnect
    // costs one harmless rescan, a swallowed real one costs the connection until reboot.
    if (state != WifiState::CONNECTED) setState(WifiState::CONNECTED);
    clearFailures(targetSsid); // F4: a good connect wipes the SSID's failure history
    // configTzTime() is idempotent-but-expensive (restarts SNTP, setenv/tzset). Once is enough:
    // the SNTP client keeps re-syncing on its own across reconnects.
    static bool tzStarted = false;
    if (!tzStarted) { configTzTime(TZ_POSIX, "pool.ntp.org", "time.google.com"); tzStarted = true; }
  }
  if (evDisconnected) {
    evDisconnected = false;
    // Same rule as before the restructure: only a drop from CONNECTED schedules a re-scan. A
    // disconnect while CONNECTING is left to the timeout branch below, which is also where the
    // per-SSID failure accounting happens (counting here too would multi-count one bad attempt,
    // since the stack can emit several DISCONNECTED events per association attempt).
    if (state == WifiState::CONNECTED) { setState(WifiState::OFFLINE); nextActionAt = now + 3000; }
  }

  switch (state) {
    case WifiState::CONNECTED:
      // R1 liveness backstop: never trust the event stream alone to get us OUT of CONNECTED. If a
      // DISCONNECTED event is dropped (queue full, flag overwritten, event delivered while the flag
      // was momentarily cleared), the old code would sit in CONNECTED for ever — the status bar
      // showing a network that is gone, netTask polling a dead link, and no rescan ever scheduled.
      // The radio's own status is the ground truth and costs one cheap read per tick.
      if (WiFi.status() != WL_CONNECTED) {
        setState(WifiState::OFFLINE);
        nextActionAt = now + 3000;
      }
      break;
    case WifiState::SCANNING: {
      int n = WiFi.scanComplete();
      if (n == WIFI_SCAN_RUNNING) {
        // F5: a scan that never completes (radio wedged, results dropped) must not park the state
        // machine here for ever — the old code had no exit at all from this branch.
        if (now - stateSince > SCAN_TIMEOUT_MS) {
          WiFi.scanDelete();
          setState(WifiState::OFFLINE);
          nextActionAt = now + 5000;
        }
        break;
      }
      if (n < 0) { // WIFI_SCAN_FAILED (-2) — sticky: it returns -2 on every subsequent call too
        WiFi.scanDelete();
        setState(WifiState::OFFLINE);
        nextActionAt = now + 5000;
        break;
      }
      // pick the strongest known network that isn't currently blocked (F4)
      int bestRssi = -999; int bestIdx = -1;
      for (int i = 0; i < n; i++) {
        for (auto &c : creds) {
          if (WiFi.SSID(i) == c.ssid && WiFi.RSSI(i) > bestRssi && !ssidBlocked(c.ssid, now)) {
            bestRssi = WiFi.RSSI(i); bestIdx = i;
          }
        }
      }
      if (bestIdx >= 0) {
        targetSsid = WiFi.SSID(bestIdx);
        for (auto &c : creds) if (c.ssid == targetSsid) WiFi.begin(c.ssid.c_str(), c.pass.c_str());
        setState(WifiState::CONNECTING);
      } else {
        setState(WifiState::OFFLINE);
        nextActionAt = now + RESCAN_INTERVAL_MS;
      }
      break;
    }
    case WifiState::CONNECTING:
      if (now - stateSince > CONNECT_TIMEOUT_MS) {
        noteConnectFailure(targetSsid, now); // F4
        WiFi.disconnect();
        setState(WifiState::OFFLINE);
        nextActionAt = now + 5000;
      }
      break;
    case WifiState::OFFLINE:
      if (!creds.empty() && now >= nextActionAt) startScan();
      break;
    default: break;
  }
}

WifiState wifi_mgr_state() { return state; }
String wifi_mgr_ssid() { return state == WifiState::CONNECTED ? WiFi.SSID() : targetSsid; }
int wifi_mgr_rssi() { return WiFi.RSSI(); }
String wifi_mgr_ip() { return WiFi.localIP().toString(); }
bool wifi_mgr_has_saved() { return !creds.empty(); }
std::vector<WifiCred> wifi_mgr_saved() { return creds; }

void wifi_mgr_forget(const String &ssid) {
  creds.erase(std::remove_if(creds.begin(), creds.end(), [&](const WifiCred &c) { return c.ssid == ssid; }), creds.end());
  persist();
  if (wifi_mgr_ssid() == ssid) { WiFi.disconnect(); setState(WifiState::OFFLINE); nextActionAt = millis(); }
}

void wifi_mgr_connect_to(const String &ssid, const String &pass) {
  creds.erase(std::remove_if(creds.begin(), creds.end(), [&](const WifiCred &c) { return c.ssid == ssid; }), creds.end());
  creds.insert(creds.begin(), {ssid, pass});
  while (creds.size() > MAX_NETWORKS) creds.pop_back();
  persist();
  clearFailures(ssid); // F4: an explicit user retry (maybe with a corrected password) unblocks it
  WiFi.disconnect();
  targetSsid = ssid;
  WiFi.begin(ssid.c_str(), pass.c_str());
  setState(WifiState::CONNECTING);
}

// Final-review F2: the UI scan and the state machine's own scan share ONE hardware scan resource.
// Unconditionally calling scanDelete()+scanNetworks() here used to delete results the state
// machine was about to read (and scanNetworks() starts nothing while a scan is in flight anyway).
// If a machine scan is already running, just mark the UI as a second consumer of it.
void wifi_mgr_request_scan() {
  uiScanPending = true;
  uiScanStartedAt = millis();
  if (state == WifiState::SCANNING) return; // in-flight machine scan serves both consumers
  WiFi.scanNetworks(true); // no scanDelete() first — see startScan()'s comment
}

bool wifi_mgr_scan_done(std::vector<std::pair<String, int>> &out) {
  if (!uiScanPending) return false;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) {
    // Don't leave the modal spinning for ever if the scan silently dies (F5's UI-side twin).
    if (millis() - uiScanStartedAt > UI_SCAN_TIMEOUT_MS) { uiScanPending = false; out.clear(); return true; }
    return false;
  }
  uiScanPending = false;
  out.clear();
  if (n < 0) return true; // WIFI_SCAN_FAILED: report "done, nothing found" rather than hanging
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (s.isEmpty()) continue;
    bool dup = false;
    for (auto &e : out) if (e.first == s) { dup = true; if (WiFi.RSSI(i) > e.second) e.second = WiFi.RSSI(i); }
    if (!dup) out.push_back({s, WiFi.RSSI(i)});
  }
  std::sort(out.begin(), out.end(), [](auto &a, auto &b) { return a.second > b.second; });
  // Final-review F2: this used to fire on ANY completed UI scan, so opening "Add network" during
  // the 15s association window overwrote CONNECTING with OFFLINE and abandoned the attempt (and
  // could equally kill the connection the user had just started from the keyboard). Only nudge the
  // machine when it is genuinely idle — SCANNING owns its own results, CONNECTING owns its timeout,
  // CONNECTED needs nothing.
  if ((state == WifiState::OFFLINE || state == WifiState::IDLE) && !creds.empty()) {
    nextActionAt = millis();
    setState(WifiState::OFFLINE);
  }
  return true;
}
