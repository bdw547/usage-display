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
  // R2: the monotonic guard above must not become a permanent stall. If the cached stamp is in the
  // FUTURE — a machine whose clock was ahead and has since been corrected (NTP step, VM resume,
  // manual fix), or a vendor stamp minted by a fast clock — then every honest result from now on
  // looks "older" and the section would freeze at the future-stamped value until it aged out.
  // Reality outranks a stamp that cannot exist yet: accept when the cache is future-dated.
  return nextAt >= cachedAt || cachedAt > Date.now();
}
