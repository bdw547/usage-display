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

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has('--once');
const PRINT = ARGS.has('--print');
const NO_PUSH = ARGS.has('--no-push');

const HOME = homedir();
const STATE_PATH = join(HOME, '.local/share/usage-collector/state.json');
const PROJECTS_DIR = join(HOME, '.claude/projects');

const PUSH_EVERY_MS = 30_000;
const POLLS = [
  { key: 'claudeLimits', everyMs: 5 * 60_000, fn: () => fetchClaudeLimits() },
  { key: 'codexLimits', everyMs: 5 * 60_000, fn: () => fetchCodexLimits() },
  { key: 'copilotQuota', everyMs: 10 * 60_000, fn: () => fetchCopilotQuota() },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const config = loadConfig();
  const state = loadState(STATE_PATH);
  const cache = { claudeLimits: null, claudeTokens: null, codexLimits: null, copilotQuota: null };
  const nextAt = Object.fromEntries(POLLS.map((p) => [p.key, 0]));
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  log(`usage-collector starting: machine=${config.machineId} relay=${config.relayUrl}`);

  do {
    const cycleStart = Date.now();

    // 1) Local token scan (cheap; every cycle)
    try {
      scanClaudeTokens(state, { projectsDir: PROJECTS_DIR });
      cache.claudeTokens = tokenWindows(state, {});
      saveState(STATE_PATH, state);
    } catch (err) {
      log('token scan failed:', err.message);
    }

    // 2) Vendor polls on their own cadences; failures keep the last good value
    for (const p of POLLS) {
      if (Date.now() < nextAt[p.key] && !ONCE) continue;
      nextAt[p.key] = Date.now() + p.everyMs + Math.floor(Math.random() * 15_000); // jitter
      try {
        const v = await p.fn();
        if (v) cache[p.key] = v;
        else log(`${p.key}: no fresh data (kept last value)`);
      } catch (err) {
        log(`${p.key} failed:`, err.message);
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

  saveState(STATE_PATH, state);
  log('usage-collector stopped');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
