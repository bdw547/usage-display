export async function pushSnapshot(snapshot, { relayUrl, pushToken, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${relayUrl}/v1/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pushToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
