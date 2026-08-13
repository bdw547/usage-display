import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.js';

test('round-trips state and tolerates missing/corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc-'));
  const p = join(dir, 'state.json');
  const empty = loadState(p);
  assert.deepEqual(empty, { files: {}, days: {}, seen: {} });
  empty.days['2026-08-13'] = { 'claude-fable-5': { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, cw5m: 4, cw1h: 0 } };
  saveState(p, empty);
  const back = loadState(p);
  assert.equal(back.days['2026-08-13']['claude-fable-5'].out, 2);
});
