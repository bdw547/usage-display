import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costUsd } from '../src/prices.js';

test('longest-prefix model matching, date suffixes included', () => {
  assert.deepEqual(priceFor('claude-fable-5'), { inP: 10, outP: 50 });
  assert.deepEqual(priceFor('claude-opus-4-5-20251101'), { inP: 5, outP: 25 });
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), { inP: 15, outP: 75 });
  assert.deepEqual(priceFor('claude-sonnet-4-6'), { inP: 3, outP: 15 });
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { inP: 1, outP: 5 });
  assert.equal(priceFor('<synthetic>'), null);
  assert.equal(priceFor('mystery-model-9000'), null);
});

test('cost math: out + in + 0.1x cache read + 1.25x/2x cache writes, per MTok', () => {
  const price = { inP: 10, outP: 50 };
  // 1M of each bucket: 10 + 50 + 1 + 12.5 + 20 = 93.5
  const c = costUsd({ in: 1e6, out: 1e6, cacheRead: 1e6, cw5m: 1e6, cw1h: 1e6 }, price);
  assert.ok(Math.abs(c - 93.5) < 1e-9, `got ${c}`);
  assert.equal(costUsd({ in: 0, out: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, price), 0);
});
