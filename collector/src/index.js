#!/usr/bin/env node
// collector/src/index.js — usage-collector daemon.
// Flags: --once (single cycle then exit), --print (print snapshot to stdout), --no-push
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { scanClaudeTokens, tokenWindows } from './sources/claude-tokens.js';
import { fetchClaudeLimits } from './sources/claude-limits.js';
import { fetchCodexLimits } from './sources/codex.js';
import { fetchCopilotQuota } from './sources/copilot.js';
import { buildSnapshot } from './snapshot.js';
import { pushSnapshot } from './push.js';
import { acceptPollResult } from './poll.js';
import { shouldSave } from './persist.js';

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has('--once');
const PRINT = ARGS.has('--print');
const NO_PUSH = ARGS.has('--no-push');

const HOME = homedir();
const STATE_PATH = join(HOME, '.local/share/usage-collector/state.json');
const PROJECTS_DIR = join(HOME, '.claude/projects');

const PUSH_EVERY_MS = 30_000;
const SAVE_MIN_INTERVAL_MS = 60_000;   // at most one ~1.4MB state write per minute
const POLLS = [
  { key: 'claudeLimits', everyMs: 5 * 60_000, fn: () => fetchClaudeLimits() },
  { key: 'codexLimits', everyMs: 5 * 60_000, fn: () => fetchCodexLimits({ log: (m) => log('codexLimits:', m) }) },
  { key: 'copilotQuota', everyMs: 10 * 60_000, fn: () => fetchCopilotQuota() },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const config = loadConfig();
  const state = loadState(STATE_PATH);
  // B6: restart with the last-good vendor sections instead of nulls (claudeTokens is
  // recomputed from state.days every cycle, so it is not persisted separately).
  const cache = {
    claudeLimits: state.cache.claudeLimits,
    claudeTokens: null,
    codexLimits: state.cache.codexLimits,
    copilotQuota: state.cache.copilotQuota,
  };
  const persistCache = () => {
    state.cache = { claudeLimits: cache.claudeLimits, codexLimits: cache.codexLimits, copilotQuota: cache.copilotQuota };
  };
  persistCache();
  const nextAt = Object.fromEntries(POLLS.map((p) => [p.key, 0]));
  let dirty = false;
  let lastSaveMs = 0;
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  log(`usage-collector starting: machine=${config.machineId} relay=${config.relayUrl}`);

  do {
    const cycleStart = Date.now();

    // 1) Local token scan (cheap; every cycle)
    try {
      if (scanClaudeTokens(state, { projectsDir: PROJECTS_DIR })) dirty = true;
      cache.claudeTokens = tokenWindows(state, {});
    } catch (err) {
      log('token scan failed:', err.message);
    }

    // 2) Vendor polls on their own cadences; failures keep the last good value
    let cacheChanged = false;
    for (const p of POLLS) {
      if (Date.now() < nextAt[p.key] && !ONCE) continue;
      nextAt[p.key] = Date.now() + p.everyMs + Math.floor(Math.random() * 15_000); // jitter
      try {
        const v = await p.fn();
        // B7: never let a fallback path (e.g. Codex rollout files) rewind a section.
        if (acceptPollResult(cache[p.key], v)) {
          cache[p.key] = v;
          cacheChanged = true;
        } else if (v) {
          log(`${p.key}: ignored a result older than the cached one (kept last value)`);
        } else {
          log(`${p.key}: no fresh data (kept last value)`);
        }
      } catch (err) {
        log(`${p.key} failed:`, err.message);
      }
    }
    if (cacheChanged) {
      persistCache(); // B6: survive a restart
      dirty = true;
    }

    // One throttled save site: the whole ~1.4MB file is rewritten per save, so skip
    // the cycles that changed nothing and rate-limit the rest. A clean shutdown still
    // flushes unconditionally after the loop.
    if (shouldSave({ dirty, lastSaveMs, nowMs: Date.now(), minIntervalMs: SAVE_MIN_INTERVAL_MS })) {
      try {
        saveState(STATE_PATH, state);
        lastSaveMs = Date.now();
        dirty = false;
      } catch (err) {
        log('state save failed:', err.message); // stays dirty; retried next cycle
      }
    }

    // 3) Assemble + push
    const snapshot = buildSnapshot(cache, { machineId: config.machineId });
    if (PRINT) console.log(JSON.stringify(snapshot, null, 2));
    if (!NO_PUSH) {
      const ok = await pushSnapshot(snapshot, config);
      if (!ok) log('push failed (will retry next cycle)');
    }

    if (ONCE) break;
    const sleep = Math.max(1000, PUSH_EVERY_MS - (Date.now() - cycleStart));
    await new Promise((r) => setTimeout(r, sleep));
  } while (!stopping);

  persistCache();
  saveState(STATE_PATH, state);
  log('usage-collector stopped');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
