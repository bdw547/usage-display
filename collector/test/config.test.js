import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function homeWith(files) {
  const home = mkdtempSync(join(tmpdir(), 'uc-'));
  mkdirSync(join(home, '.config/usage-collector'), { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    writeFileSync(join(home, '.config/usage-collector', name), JSON.stringify(obj));
  }
  return home;
}

test('reads config.json', () => {
  const home = homeWith({ 'config.json': { relayUrl: 'https://r.example', pushToken: 'p', machineId: 'box' } });
  const c = loadConfig({ home });
  assert.equal(c.relayUrl, 'https://r.example');
  assert.equal(c.machineId, 'box');
});

test('falls back to tokens.json (written by relay deploy) and defaults machineId to hostname', () => {
  const home = homeWith({ 'tokens.json': { relayUrl: 'https://r.example', pushToken: 'p', readToken: 'r' } });
  const c = loadConfig({ home });
  assert.equal(c.pushToken, 'p');
  assert.ok(c.machineId.length > 0);
});

test('throws a helpful error when nothing is configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'uc-'));
  assert.throws(() => loadConfig({ home }), /usage-collector\/config\.json/);
});
