import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanClaudeTokens, tokenWindows } from '../src/sources/claude-tokens.js';

const FIXTURES = new URL('./fixtures/claude-projects', import.meta.url).pathname;
const NOW = new Date('2026-08-13T20:00:00'); // local time
const freshState = () => ({ files: {}, days: {}, seen: {} });

test('scan aggregates per-day per-model, dedupes, skips synthetic and non-assistant lines', () => {
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: FIXTURES, now: NOW });
  const d13 = state.days['2026-08-13']['claude-fable-5'];
  assert.equal(d13.in, 100, 'duplicate msg_1/req_1 counted once');
  assert.equal(d13.out, 200);
  assert.equal(d13.cacheRead, 1000);
  assert.equal(d13.cw5m, 100);
  assert.equal(d13.cw1h, 300);
  assert.ok(!state.days['2026-08-13']['<synthetic>'], 'synthetic model skipped');
  assert.equal(state.days['2026-08-10']['claude-opus-4-5-20251101'].out, 20);
  assert.equal(state.days['2026-07-01']['claude-fable-5'].out, 2000);
});

test('incremental: second scan reads nothing new; appended line is picked up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-proj-'));
  cpSync(FIXTURES, dir, { recursive: true });
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  const before = JSON.stringify(state.days);
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  assert.equal(JSON.stringify(state.days), before, 'no double counting on rescan');
  appendFileSync(join(dir, 'proj-a/session1.jsonl'),
    '\n{"type":"assistant","uuid":"a9","requestId":"req_10","timestamp":"2026-08-13T13:00:00","message":{"id":"msg_10","model":"claude-fable-5","usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
  scanClaudeTokens(state, { projectsDir: dir, now: NOW });
  assert.equal(state.days['2026-08-13']['claude-fable-5'].in, 107);
});

test('windows: today / rolling-7d / calendar month / all-time + cost', () => {
  const state = freshState();
  scanClaudeTokens(state, { projectsDir: FIXTURES, now: NOW });
  const w = tokenWindows(state, { now: NOW });
  // today (2026-08-13, fable): in100 out200 cr1000 cw400 => total 1700
  assert.equal(w.today.total, 1700);
  // week = 8/07..8/13 → includes 8/10 opus (10+20) and today's 1700 → 1730
  assert.equal(w.week.total, 1730);
  // month = 2026-08 → same as week here
  assert.equal(w.month.total, 1730);
  // all time adds July's 3000
  assert.equal(w.allTime.total, 4730);
  // cost: fable today = (100*10 + 200*50 + 1000*10*0.1 + 100*10*1.25 + 300*10*2)/1e6
  //     = (1000 + 10000 + 1000 + 1250 + 6000)/1e6 = 0.01925
  // opus 4.5 (8/10) = (10*5 + 20*25)/1e6 = 0.00055 ; July fable = (1000*10+2000*50)/1e6 = 0.11
  // (rounded to 2 decimals: 0.02 and 0.13, so tolerance adjusted for rounding + float epsilon)
  assert.ok(Math.abs(w.costUsd.month - 0.0198) < 0.0003, `month ${w.costUsd.month}`);
  assert.ok(Math.abs(w.costUsd.allTime - 0.1298) < 0.0003, `allTime ${w.costUsd.allTime}`);
  assert.ok(w.computedAt);
});
