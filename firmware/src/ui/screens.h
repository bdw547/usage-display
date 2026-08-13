#pragma once
#include <lvgl.h>
#include "../model.h"
void screen_claude_build(lv_obj_t *tile);
void screen_codex_build(lv_obj_t *tile);
void screen_copilot_build(lv_obj_t *tile);
void screen_tokens_build(lv_obj_t *tile);
void screen_claude_apply(const UsageData &u);
void screen_codex_apply(const UsageData &u);
void screen_copilot_apply(const UsageData &u);
void screen_tokens_apply(const UsageData &u);
void screens_tick_1s(const UsageData &u); // refresh countdowns from receivedAtMs drift
