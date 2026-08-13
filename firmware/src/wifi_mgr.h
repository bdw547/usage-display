// firmware/src/wifi_mgr.h
#pragma once
#include <Arduino.h>
#include <vector>

struct WifiCred { String ssid; String pass; };
enum class WifiState { IDLE, SCANNING, CONNECTING, CONNECTED, OFFLINE };

void wifi_mgr_init();                      // load creds, register events, start first scan
void wifi_mgr_tick();                      // call from loop(); drives the state machine
WifiState wifi_mgr_state();
String wifi_mgr_ssid();                    // current/target SSID
int wifi_mgr_rssi();
String wifi_mgr_ip();
bool wifi_mgr_has_saved();                 // any saved networks?
std::vector<WifiCred> wifi_mgr_saved();    // for the Settings list
void wifi_mgr_forget(const String &ssid);
void wifi_mgr_connect_to(const String &ssid, const String &pass); // save (front of list) + connect now
// UI-triggered scan for the "Add network" screen:
void wifi_mgr_request_scan();
bool wifi_mgr_scan_done(std::vector<std::pair<String,int>> &out); // (ssid, rssi), best first, deduped
