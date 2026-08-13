// B7: keep-last-good must never move a section BACKWARDS in time.
// fetchCodexLimits() falls back to the newest rollout file when the live endpoint
// fails, and that file can be hours older than the value already in the cache;
// accepting it would rewind the percentages the device shows and make the merged
// summary look freshly fetched while carrying older numbers.
export function acceptPollResult(cached, next) {
  if (!next || typeof next !== 'object') return false;
  const nextAt = Date.parse(next.fetchedAt ?? '');
  if (Number.isNaN(nextAt)) return false;  // no usable stamp: cannot prove it is newer
  if (!cached || typeof cached !== 'object') return true;
  const cachedAt = Date.parse(cached.fetchedAt ?? '');
  if (Number.isNaN(cachedAt)) return true; // whatever we hold is unusable anyway
  return nextAt >= cachedAt;
}
