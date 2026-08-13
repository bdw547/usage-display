import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return { files: s.files ?? {}, days: s.days ?? {}, seen: s.seen ?? {} };
  } catch {
    return { files: {}, days: {}, seen: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
