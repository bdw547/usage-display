#pragma once
#include <lvgl.h>
#include "../model.h"
void ui_init();
void ui_apply(const UsageData &u);
void ui_tick_1s();
void ui_goto_settings();
lv_obj_t *ui_settings_parent(); // 5th tile; Task 8 builds the settings page inside it
