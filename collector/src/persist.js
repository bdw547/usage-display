// The state file is rewritten whole (~1.4MB) on every save, so saving every cycle
// costs ~4GB/day of disk writes to persist a few new byte offsets. Two rules cut
// that: never write a cycle that changed nothing, and write at most once per
// minIntervalMs when it did. Losing up to minIntervalMs of progress to a crash is
// safe — offsets, dedupe keys and day totals are saved together atomically, so the
// next start replays those transcript lines and the dedupe map drops the repeats.
export function shouldSave({ dirty, lastSaveMs, nowMs, minIntervalMs }) {
  if (!dirty) return false;
  if (!lastSaveMs) return true;   // nothing saved yet this process: flush the first change
  const sinceMs = nowMs - lastSaveMs;
  if (sinceMs < 0) return true;   // clock stepped backwards: write rather than wedge shut
  return sinceMs >= minIntervalMs;
}
