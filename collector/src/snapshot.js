export function buildSnapshot(cache, { machineId, now = new Date() }) {
  return {
    v: 1,
    machineId,
    sentAt: new Date(now).toISOString(),
    claude: { limits: cache.claudeLimits ?? null, tokens: cache.claudeTokens ?? null },
    codex: { limits: cache.codexLimits ?? null },
    copilot: { quota: cache.copilotQuota ?? null },
  };
}
