import { readFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

export function loadConfig({ home = homedir() } = {}) {
  const dir = join(home, '.config/usage-collector');
  let raw = null;
  for (const name of ['config.json', 'tokens.json']) {
    try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')); break; } catch { /* try next */ }
  }
  if (!raw || !raw.relayUrl || !raw.pushToken) {
    throw new Error(
      'Missing configuration. Create ~/.config/usage-collector/config.json with {"relayUrl": "...", "pushToken": "..."} ' +
      '(the relay deploy step writes tokens.json there, which also works).'
    );
  }
  return { relayUrl: raw.relayUrl.replace(/\/$/, ''), pushToken: raw.pushToken, machineId: raw.machineId || hostname() };
}
