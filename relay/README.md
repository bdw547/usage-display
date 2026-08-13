# usage-relay

Cloudflare Worker + KV. Collectors POST per-machine snapshots; the display GETs a merged summary.

- `POST /v1/push`  — `Authorization: Bearer <PUSH_TOKEN>`, body = snapshot v1. Stored as `machine:<machineId>`, TTL 7 days.
- `GET /v1/summary` — `Authorization: Bearer <READ_TOKEN>`. Merged view; tokens summed across machines, limits from the freshest machine; all times relative (`ageSec`, `resetsInSec`).

Deploy: `npm install && npx wrangler deploy`. Secrets: `npx wrangler secret put PUSH_TOKEN` / `READ_TOKEN`.
Local dev: `npx wrangler dev` with `.dev.vars` containing `PUSH_TOKEN=... READ_TOKEN=...`.
Tokens + URL for the other components live in `~/.config/usage-collector/tokens.json` (created at deploy time, mode 600, not in git).
