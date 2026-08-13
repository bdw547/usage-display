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

test('B7: unusable timestamps degrade safely', () => {
  assert.equal(acceptPollResult(at('2026-08-13T16:00:00Z'), { pct: 5 }), false, 'no fetchedAt: cannot prove it is newer');
  assert.equal(acceptPollResult(at('2026-08-13T16:00:00Z'), at('garbage')), false);
  assert.equal(acceptPollResult(at('garbage'), at('2026-08-13T16:00:00Z')), true, 'replace an unusable cached stamp');
});
