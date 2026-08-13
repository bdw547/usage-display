// firmware/src/wifi_mgr.cpp
#include "wifi_mgr.h"
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "secrets.h"

static Preferences prefs;
static std::vector<WifiCred> creds;
static WifiState state = WifiState::IDLE;
static String targetSsid;
static uint32_t stateSince = 0;
static uint32_t nextActionAt = 0;
static bool uiScanPending = false;

static const uint32_t CONNECT_TIMEOUT_MS = 15000;
static const uint32_t RESCAN_INTERVAL_MS = 30000;
static const size_t MAX_NETWORKS = 8;

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
  WiFi.scanDelete();
  WiFi.scanNetworks(true /* async */);
  setState(WifiState::SCANNING);
}

void wifi_mgr_init() {
  prefs.begin("wifinet", false);
  loadCreds();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // the state machine owns reconnects
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t) {
    if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      setState(WifiState::CONNECTED);
      configTzTime(TZ_POSIX, "pool.ntp.org", "time.google.com");
    } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      if (state == WifiState::CONNECTED) { setState(WifiState::OFFLINE); nextActionAt = millis() + 3000; }
    }
  });
  if (!creds.empty()) startScan(); else setState(WifiState::OFFLINE);
}

void wifi_mgr_tick() {
  uint32_t now = millis();
  switch (state) {
    case WifiState::SCANNING: {
      int n = WiFi.scanComplete();
      if (n < 0) break; // still running
      // pick the strongest known network
      int bestRssi = -999; int bestIdx = -1;
      for (int i = 0; i < n; i++) {
        for (auto &c : creds) {
          if (WiFi.SSID(i) == c.ssid && WiFi.RSSI(i) > bestRssi) { bestRssi = WiFi.RSSI(i); bestIdx = i; }
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
      if (now - stateSince > CONNECT_TIMEOUT_MS) { WiFi.disconnect(); setState(WifiState::OFFLINE); nextActionAt = now + 5000; }
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
  WiFi.disconnect();
  targetSsid = ssid;
  WiFi.begin(ssid.c_str(), pass.c_str());
  setState(WifiState::CONNECTING);
}

void wifi_mgr_request_scan() { uiScanPending = true; WiFi.scanDelete(); WiFi.scanNetworks(true); }

bool wifi_mgr_scan_done(std::vector<std::pair<String, int>> &out) {
  if (!uiScanPending) return false;
  int n = WiFi.scanComplete();
  if (n < 0) return false;
  uiScanPending = false;
  out.clear();
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (s.isEmpty()) continue;
    bool dup = false;
    for (auto &e : out) if (e.first == s) { dup = true; if (WiFi.RSSI(i) > e.second) e.second = WiFi.RSSI(i); }
    if (!dup) out.push_back({s, WiFi.RSSI(i)});
  }
  std::sort(out.begin(), out.end(), [](auto &a, auto &b) { return a.second > b.second; });
  // resume background reconnect logic if we're not connected
  if (state != WifiState::CONNECTED && !creds.empty()) { nextActionAt = millis(); setState(WifiState::OFFLINE); }
  return true;
}
