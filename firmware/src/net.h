// firmware/src/net.h
#pragma once
#include "model.h"
void net_start();                       // spawns the FreeRTOS fetch task (call after wifi_mgr_init)
bool net_take_update(UsageData &out);   // true once per fresh parse; copies under mutex
enum class NetStatus { NEVER, OK, WIFI_DOWN, HTTP_ERROR, AUTH_ERROR, PARSE_ERROR };
NetStatus net_status();
uint32_t net_last_ok_ms();              // millis() of last successful fetch (0 = never)
