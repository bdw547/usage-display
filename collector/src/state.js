import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// B6: the last-good vendor sections live here as well as in process memory, so a
// restart (deploy, reboot, `systemctl --user restart`) republishes real numbers
// instead of nulls that wipe the display until the next 5-10 minute poll lands.
const emptyCache = () => ({ claudeLimits: null, codexLimits: null, copilotQuota: null });

export function loadState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return {
      files: s.files ?? {},
      days: s.days ?? {},
      seen: s.seen ?? {},
      cache: { ...emptyCache(), ...(s.cache && typeof s.cache === 'object' ? s.cache : {}) },
    };
  } catch {
    return { files: {}, days: {}, seen: {}, cache: emptyCache() };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
