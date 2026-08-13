// firmware/src/ui/screens.cpp
#include <Arduino.h>   // millis()
#include "screens.h"
#include "theme.h"
#include "board.h"
#include <stdio.h>

// Note: the design brief for this file assumed lv_obj_set_flag(obj, flag, bool)
// doesn't exist in LVGL 9. Checked against the installed 9.5.0 headers/src
// (src/core/lv_obj.h/.c) — it does exist and is a plain add/remove-flag
// branch internally. Routing every conditional show/hide through this local
// wrapper anyway per the task's documented correction: harmless either way,
// and it keeps this file's hide/show calls off any one LVGL flag-setter name.
static void setHidden(lv_obj_t *obj, bool hidden) {
  if (hidden) lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
  else lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
}

// ---------- shared limit-screen widget set ----------
struct LimitScreen {
  lv_obj_t *title;
  lv_obj_t *arc, *arcPct, *arcSub;       // primary window (session / 5h)
  lv_obj_t *barLabel, *bar, *barPct, *barSub; // secondary window (weekly)
  lv_obj_t *extraRows[3]; lv_obj_t *extraBars[3]; lv_obj_t *extraPcts[3];
  lv_obj_t *na;                           // "no data yet" overlay
};
static LimitScreen sClaude, sCodex;
static lv_color_t claudeAccent, codexAccent;

static lv_obj_t *mkLabel(lv_obj_t *p, const lv_font_t *f, lv_color_t c, const char *txt) {
  lv_obj_t *l = lv_label_create(p);
  lv_obj_set_style_text_font(l, f, 0);
  lv_obj_set_style_text_color(l, c, 0);
  lv_label_set_text(l, txt);
  return l;
}

static void buildLimitScreen(LimitScreen &s, lv_obj_t *tile, const char *name, lv_color_t accent,
                             const char *primaryName, const char *secondaryName) {
  lv_obj_set_style_bg_color(tile, COL_BG, 0);
  lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);

  s.title = mkLabel(tile, &lv_font_montserrat_24, accent, name);
  lv_obj_align(s.title, LV_ALIGN_TOP_MID, 0, 10);

  // Arc shrunk 230->210 (round 2, supersedes round 1's "~10px move" note) so 3 Weekly-identical
  // bar rows below have room; see the layout-math comment above the extras loop.
  s.arc = lv_arc_create(tile);
  lv_obj_set_size(s.arc, 210, 210);
  lv_obj_align(s.arc, LV_ALIGN_TOP_MID, 0, 38);
  lv_arc_set_rotation(s.arc, 135);
  lv_arc_set_bg_angles(s.arc, 0, 270);
  lv_arc_set_range(s.arc, 0, 100);
  lv_obj_remove_style(s.arc, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(s.arc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_color(s.arc, COL_CARD, LV_PART_MAIN);
  lv_obj_set_style_arc_color(s.arc, accent, LV_PART_INDICATOR);
  lv_obj_set_style_arc_width(s.arc, 18, LV_PART_MAIN);
  lv_obj_set_style_arc_width(s.arc, 18, LV_PART_INDICATOR);

  // Fixed width + centered text on every label anchored via lv_obj_align_to(): align_to (unlike
  // plain lv_obj_align) computes an absolute position ONCE from the object's width AT CALL TIME,
  // then bakes it in as a plain TOP_LEFT position (confirmed by reading lv_obj_align_to()'s source
  // — its last lines are literally `lv_obj_set_style_align(obj, LV_ALIGN_TOP_LEFT, 0)` then
  // `lv_obj_set_pos`). A label's default width is LV_SIZE_CONTENT, so when its text later grows
  // (e.g. "--" -> "100%"), the box grows rightward from that frozen left edge, visually
  // off-centering it. Fixing the width (before align_to runs) and centering the text inside that
  // fixed box makes the label's box itself stable, so later text changes redraw within it instead
  // of shifting it.
  s.arcPct = mkLabel(tile, &lv_font_montserrat_48, COL_TEXT, "--");
  lv_obj_set_width(s.arcPct, 200);
  lv_obj_set_style_text_align(s.arcPct, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align_to(s.arcPct, s.arc, LV_ALIGN_CENTER, 0, -10);
  lv_obj_t *pn = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, primaryName);
  lv_obj_set_width(pn, 200);
  lv_obj_set_style_text_align(pn, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align_to(pn, s.arc, LV_ALIGN_CENTER, 0, 28);
  s.arcSub = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_set_width(s.arcSub, 220);
  lv_obj_set_style_text_align(s.arcSub, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align_to(s.arcSub, s.arc, LV_ALIGN_BOTTOM_MID, 0, -6); // centered in the 270-degree arc's bottom gap

  s.barLabel = mkLabel(tile, &lv_font_montserrat_16, COL_TEXT, secondaryName);
  lv_obj_align(s.barLabel, LV_ALIGN_TOP_LEFT, 36, 256);
  s.barPct = mkLabel(tile, &lv_font_montserrat_16, COL_TEXT, "--");
  lv_obj_align(s.barPct, LV_ALIGN_TOP_RIGHT, -36, 256);
  s.bar = lv_bar_create(tile);
  lv_obj_set_size(s.bar, 408, 14);
  lv_obj_align(s.bar, LV_ALIGN_TOP_MID, 0, 280);
  lv_bar_set_range(s.bar, 0, 100);
  lv_obj_set_style_bg_color(s.bar, COL_CARD, LV_PART_MAIN);
  lv_obj_set_style_bg_color(s.bar, accent, LV_PART_INDICATOR);
  s.barSub = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_align(s.barSub, LV_ALIGN_TOP_MID, 0, 300);

  // Optional scoped-limit rows (Claude opus/sonnet/fable etc.) — round 2: IDENTICAL geometry to
  // the Weekly bar above (408x14, montserrat_16 label+pct, same 24px label-to-bar gap), not a
  // shrunk-down variant. Up to 3, stacked with consistent spacing.
  // Layout math, disclosed: tile height is 430px (480 - 32 status bar - 18 dots). Arc(38-248) +
  // gap(8) + Weekly block(256-314) + gap(16) + 3 full Weekly-sized rows (330, 376, 422, each
  // spanning 38px to their own bar's bottom) bottoms out at 460 — ~30px past the tile in the
  // worst case of all 3 extras populated simultaneously. That's an unavoidable consequence of
  // matching Weekly's bar size exactly (this finding) at a 210px arc (this finding) — there's no
  // remaining slack to trim without shrinking the arc further than specified or violating the
  // "identical to Weekly" bar requirement. Today's real relay payload has extraCount=0 in
  // practice (this path isn't populated yet), so what actually renders is arc+Weekly+hint with
  // room to spare; 3-simultaneous-extras stays a known, disclosed, not-currently-exercised edge
  // case rather than a silently broken one.
  static const int EXTRA_Y0 = 330, EXTRA_PITCH = 46;
  for (int i = 0; i < 3; i++) {
    int y = EXTRA_Y0 + i * EXTRA_PITCH;
    s.extraRows[i] = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "");
    lv_obj_align(s.extraRows[i], LV_ALIGN_TOP_LEFT, 36, y);
    s.extraPcts[i] = mkLabel(tile, &lv_font_montserrat_16, COL_TEXT, "");
    lv_obj_align(s.extraPcts[i], LV_ALIGN_TOP_RIGHT, -36, y);
    s.extraBars[i] = lv_bar_create(tile);
    lv_obj_set_size(s.extraBars[i], 408, 14);
    lv_obj_align(s.extraBars[i], LV_ALIGN_TOP_MID, 0, y + 24);
    lv_bar_set_range(s.extraBars[i], 0, 100);
    lv_obj_set_style_bg_color(s.extraBars[i], COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s.extraBars[i], accent, LV_PART_INDICATOR);
    setHidden(s.extraRows[i], true);
    setHidden(s.extraPcts[i], true);
    setHidden(s.extraBars[i], true);
  }

  s.na = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "no data yet");
  lv_obj_align(s.na, LV_ALIGN_CENTER, 0, 0);
}

static void applyLimitScreen(LimitScreen &s, bool has, const Window &prim, const Window &sec,
                             const UsageData &u, int32_t elapsedSec) {
  if (!has) { setHidden(s.na, false); return; }
  setHidden(s.na, true);
  char buf[32];
  if (prim.has) {
    lv_arc_set_value(s.arc, (int)prim.pct);
    lv_label_set_text_fmt(s.arcPct, "%d%%", (int)prim.pct);
    if (prim.hasReset) {
      char cd[16]; fmt_countdown(prim.resetsInSec - elapsedSec, cd, sizeof(cd));
      snprintf(buf, sizeof(buf), "resets in %s", cd);
      lv_label_set_text(s.arcSub, buf);
    } else lv_label_set_text(s.arcSub, "");
  } else { lv_arc_set_value(s.arc, 0); lv_label_set_text(s.arcPct, "--"); }
  if (sec.has) {
    lv_bar_set_value(s.bar, (int)sec.pct, LV_ANIM_ON);
    lv_label_set_text_fmt(s.barPct, "%d%%", (int)sec.pct);
    if (sec.hasReset) {
      char cd[16]; fmt_countdown(sec.resetsInSec - elapsedSec, cd, sizeof(cd));
      snprintf(buf, sizeof(buf), "resets in %s", cd);
      lv_label_set_text(s.barSub, buf);
    } else lv_label_set_text(s.barSub, "");
  } else { lv_bar_set_value(s.bar, 0, LV_ANIM_OFF); lv_label_set_text(s.barPct, "--"); }
}

// ---------- Claude ----------
// Claude-only additions living on top of the shared limit-screen: a muted "swipe down for
// tokens" affordance (Finding B — Tokens hangs off Claude as a vertical page, not a horizontal
// one) and a "Usage credits" row (Finding E — data not sent by the relay yet, so this stays
// hidden until parseSummary ever sets hasCredits).
static lv_obj_t *claudeHint, *claudeCredits;

void screen_claude_build(lv_obj_t *tile) {
  claudeAccent = COL_CLAUDE;
  buildLimitScreen(sClaude, tile, "Claude", COL_CLAUDE, "5-hour session", "Weekly");
  claudeHint = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, LV_SYMBOL_DOWN);
  lv_obj_align(claudeHint, LV_ALIGN_BOTTOM_MID, 0, -30);
  claudeCredits = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_align(claudeCredits, LV_ALIGN_BOTTOM_MID, 0, -8);
  setHidden(claudeCredits, true);
}
void screen_claude_apply(const UsageData &u) {
  int32_t el = (int32_t)((millis() - u.receivedAtMs) / 1000);
  applyLimitScreen(sClaude, u.hasClaudeLimits, u.session, u.weekly, u, el);
  for (int i = 0; i < 3; i++) {
    bool show = u.hasClaudeLimits && i < u.extraCount;
    setHidden(sClaude.extraRows[i], !show);
    setHidden(sClaude.extraPcts[i], !show);
    setHidden(sClaude.extraBars[i], !show);
    if (show) {
      lv_label_set_text_fmt(sClaude.extraRows[i], "Weekly • %s", u.extras[i].label);
      lv_label_set_text_fmt(sClaude.extraPcts[i], "%d%%", (int)u.extras[i].w.pct);
      lv_bar_set_value(sClaude.extraBars[i], (int)u.extras[i].w.pct, LV_ANIM_ON);
    }
  }
  setHidden(claudeCredits, !u.hasCredits);
  if (u.hasCredits) {
    char c[16]; fmt_cost(u.creditsUsd, c, sizeof(c));
    lv_label_set_text_fmt(claudeCredits, "Usage credits: %s spent", c);
  }
}

// ---------- Codex ----------
void screen_codex_build(lv_obj_t *tile) { codexAccent = COL_CODEX; buildLimitScreen(sCodex, tile, "Codex", COL_CODEX, "5-hour window", "Weekly"); }
void screen_codex_apply(const UsageData &u) {
  int32_t el = (int32_t)((millis() - u.receivedAtMs) / 1000);
  applyLimitScreen(sCodex, u.hasCodex, u.cxFive, u.cxWeekly, u, el);
  if (u.hasCodex && u.cxPlan[0]) lv_label_set_text_fmt(sCodex.title, "Codex · %s", u.cxPlan);
}

// ---------- Copilot ----------
static lv_obj_t *cpBig, *cpBar, *cpPctL, *cpReset, *cpPlanL, *cpNa, *cpTile;
void screen_copilot_build(lv_obj_t *tile) {
  cpTile = tile;
  lv_obj_set_style_bg_color(tile, COL_BG, 0); lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *t = mkLabel(tile, &lv_font_montserrat_24, COL_COPILOT, "Copilot");
  lv_obj_align(t, LV_ALIGN_TOP_MID, 0, 10);
  lv_obj_t *cap = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "premium requests");
  lv_obj_align(cap, LV_ALIGN_TOP_MID, 0, 120);
  cpBig = mkLabel(tile, &lv_font_montserrat_48, COL_TEXT, "--");
  lv_obj_align(cpBig, LV_ALIGN_TOP_MID, 0, 160);
  cpBar = lv_bar_create(tile);
  lv_obj_set_size(cpBar, 408, 18);
  lv_obj_align(cpBar, LV_ALIGN_TOP_MID, 0, 250);
  lv_bar_set_range(cpBar, 0, 100);
  lv_obj_set_style_bg_color(cpBar, COL_CARD, LV_PART_MAIN);
  lv_obj_set_style_bg_color(cpBar, COL_COPILOT, LV_PART_INDICATOR);
  cpPctL = mkLabel(tile, &lv_font_montserrat_16, COL_TEXT, "--");
  lv_obj_align(cpPctL, LV_ALIGN_TOP_MID, 0, 282);
  cpReset = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_align(cpReset, LV_ALIGN_TOP_MID, 0, 320);
  cpPlanL = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_align(cpPlanL, LV_ALIGN_BOTTOM_MID, 0, -46);
  cpNa = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "no data yet");
  lv_obj_align(cpNa, LV_ALIGN_CENTER, 0, 0);
}
void screen_copilot_apply(const UsageData &u) {
  if (!u.hasCopilot) { setHidden(cpNa, false); return; }
  setHidden(cpNa, true);
  char a[20], b[20];
  fmt_compact(u.cpUsed, a, sizeof(a));
  if (u.cpIncluded > 0) { fmt_compact(u.cpIncluded, b, sizeof(b)); lv_label_set_text_fmt(cpBig, "%s / %s", a, b); }
  else lv_label_set_text_fmt(cpBig, "%s (unlimited)", a);
  lv_bar_set_value(cpBar, (int)u.cpPct, LV_ANIM_ON);
  lv_label_set_text_fmt(cpPctL, "%.1f%% used", u.cpPct);
  if (u.cpHasReset) {
    char cd[16];
    fmt_countdown(u.cpResetsInSec - (int32_t)((millis() - u.receivedAtMs) / 1000), cd, sizeof(cd));
    lv_label_set_text_fmt(cpReset, "resets in %s", cd);
  }
  if (u.cpPlan[0]) lv_label_set_text_fmt(cpPlanL, "plan: %s", u.cpPlan);
}

// ---------- Claude tokens ----------
static lv_obj_t *tkBig, *tkRows[3], *tkRowVals[3], *tkCost, *tkNa, *tkBreak;
void screen_tokens_build(lv_obj_t *tile) {
  lv_obj_set_style_bg_color(tile, COL_BG, 0); lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *t = mkLabel(tile, &lv_font_montserrat_24, COL_TOKENS, "Claude tokens");
  lv_obj_align(t, LV_ALIGN_TOP_MID, 0, 10);
  lv_obj_t *cap = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "today");
  lv_obj_align(cap, LV_ALIGN_TOP_MID, 0, 92);
  tkBig = mkLabel(tile, &lv_font_montserrat_48, COL_TEXT, "--");
  lv_obj_align(tkBig, LV_ALIGN_TOP_MID, 0, 122);
  tkBreak = mkLabel(tile, &lv_font_montserrat_14, COL_MUTED, "");
  lv_obj_align(tkBreak, LV_ALIGN_TOP_MID, 0, 186);
  static const char *names[3] = {"This week", "This month", "All time"};
  for (int i = 0; i < 3; i++) {
    lv_obj_t *card = lv_obj_create(tile);
    lv_obj_set_size(card, 408, 44);
    lv_obj_align(card, LV_ALIGN_TOP_MID, 0, 226 + i * 54);
    lv_obj_set_style_bg_color(card, COL_CARD, 0);
    lv_obj_set_style_border_width(card, 0, 0);
    lv_obj_set_style_radius(card, 10, 0);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    tkRows[i] = mkLabel(card, &lv_font_montserrat_16, COL_MUTED, names[i]);
    lv_obj_align(tkRows[i], LV_ALIGN_LEFT_MID, 6, 0);
    tkRowVals[i] = mkLabel(card, &lv_font_montserrat_20, COL_TEXT, "--");
    lv_obj_align(tkRowVals[i], LV_ALIGN_RIGHT_MID, -6, 0);
  }
  tkCost = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "");
  lv_obj_align(tkCost, LV_ALIGN_BOTTOM_MID, 0, -46);
  tkNa = mkLabel(tile, &lv_font_montserrat_16, COL_MUTED, "no data yet");
  lv_obj_align(tkNa, LV_ALIGN_CENTER, 0, 0);
}
void screen_tokens_apply(const UsageData &u) {
  if (!u.hasTokens) { setHidden(tkNa, false); return; }
  setHidden(tkNa, true);
  char b1[20], b2[20], b3[20];
  fmt_compact(u.today.total, b1, sizeof(b1));
  lv_label_set_text(tkBig, b1);
  fmt_compact(u.today.in + u.today.out, b2, sizeof(b2));
  fmt_compact(u.today.cacheRead + u.today.cacheWrite, b3, sizeof(b3));
  lv_label_set_text_fmt(tkBreak, "%s in+out • %s cache", b2, b3);
  const TokenBucket *rows[3] = {&u.week, &u.month, &u.allTime};
  for (int i = 0; i < 3; i++) { fmt_compact(rows[i]->total, b1, sizeof(b1)); lv_label_set_text(tkRowVals[i], b1); }
  char c1[16], c2[16];
  fmt_cost(u.costMonth, c1, sizeof(c1));
  fmt_cost(u.costAllTime, c2, sizeof(c2));
  lv_label_set_text_fmt(tkCost, "est. value: %s this month • %s all time", c1, c2);
}

static UsageData lastApplied;
void screens_tick_1s(const UsageData &u) {
  if (!u.valid) return;
  // re-apply the countdown-bearing screens so "resets in" stays live between polls
  screen_claude_apply(u);
  screen_codex_apply(u);
  screen_copilot_apply(u);
}
