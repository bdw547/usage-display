// USD per million tokens. Source: claude-api skill reference (cached 2026-06-24).
// Costs are ESTIMATES at API list prices — subscription usage isn't literally billed this way.
const PRICES = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4-2', 15, 75],
  ['claude-opus-4-0', 15, 75],
  ['claude-opus-4-20250514', 15, 75],
  ['claude-3-opus', 15, 75],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
].sort((a, b) => b[0].length - a[0].length); // longest prefix first

export function priceFor(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const hit = PRICES.find(([prefix]) => modelId.startsWith(prefix));
  return hit ? { inP: hit[1], outP: hit[2] } : null;
}

export function costUsd(b, { inP, outP }) {
  return (
    (b.in ?? 0) * inP +
    (b.out ?? 0) * outP +
    (b.cacheRead ?? 0) * inP * 0.1 +
    (b.cw5m ?? 0) * inP * 1.25 +
    (b.cw1h ?? 0) * inP * 2
  ) / 1e6;
}
