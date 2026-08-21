import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSave } from '../src/persist.js';

const MIN = 60_000;

test('a clean cycle never writes, however long it has been', () => {
  assert.equal(shouldSave({ dirty: false, lastSaveMs: 0, nowMs: 10 * MIN, minIntervalMs: MIN }), false);
});

test('the first dirty cycle writes immediately', () => {
  assert.equal(shouldSave({ dirty: true, lastSaveMs: 0, nowMs: 1_000, minIntervalMs: MIN }), true);
});

test('a dirty cycle inside the window defers', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs + 59_999, minIntervalMs: MIN }), false);
});

test('a dirty cycle writes once the window has elapsed', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs + MIN, minIntervalMs: MIN }), true);
});

test('a backwards clock step does not wedge the throttle shut', () => {
  const lastSaveMs = 1_000_000;
  assert.equal(shouldSave({ dirty: true, lastSaveMs, nowMs: lastSaveMs - 5 * MIN, minIntervalMs: MIN }), true);
});
