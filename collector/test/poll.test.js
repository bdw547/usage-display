import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPollResult } from '../src/poll.js';

const at = (iso) => ({ fetchedAt: iso, pct: 1 });

test('B7: nothing to accept when the poll produced no value', () => {
  assert.equal(acceptPollResult(null, null), false);
  assert.equal(acceptPollResult(at('2026-08-13T16:00:00Z'), null), false, 'a failed poll keeps the cached value');
});

test('B7: the first value is always accepted', () => {
  assert.equal(acceptPollResult(null, at('2026-08-13T16:00:00Z')), true);
});

test('B7: keep-last-good never moves a section backwards in time', () => {
  const cached = at('2026-08-13T16:00:00Z');
  assert.equal(acceptPollResult(cached, at('2026-08-13T16:05:00Z')), true, 'newer wins');
  assert.equal(acceptPollResult(cached, at('2026-08-13T16:00:00Z')), true, 'same instant refreshes in place');
  // The Codex live endpoint failing falls back to the newest rollout file, which can be
  // hours older than what we already hold — accepting it would rewind the display.
  assert.equal(acceptPollResult(cached, at('2026-08-13T14:00:00Z')), false, 'older is rejected');
});

test('R2: a future-stamped cache must not outrank reality for ever', () => {
  // A clock that was an hour ahead (then corrected) leaves a cached fetchedAt in the future.
  // Under the plain monotonic rule every honest poll from now on loses, and the section freezes.
  const future = at(new Date(Date.now() + 3600_000).toISOString());
  const now = at(new Date().toISOString());
  assert.equal(acceptPollResult(future, now), true, 'a result stamped now beats a future-dated cache');
  // ... while ordinary past-dated caches keep the monotonic protection intact.
  const past = at(new Date(Date.now() - 3600_000).toISOString());
  assert.equal(acceptPollResult(now, past), false, 'an older result is still rejected');
});

test('B7: unusable timestamps degrade safely', () => {
  assert.equal(acceptPollResult(at('2026-08-13T16:00:00Z'), { pct: 5 }), false, 'no fetchedAt: cannot prove it is newer');
  assert.equal(acceptPollResult(at('2026-08-13T16:00:00Z'), at('garbage')), false);
  assert.equal(acceptPollResult(at('garbage'), at('2026-08-13T16:00:00Z')), true, 'replace an unusable cached stamp');
});
