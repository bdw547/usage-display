# usage-relay

Cloudflare Worker + a single SQLite-backed Durable Object. Collectors POST per-machine snapshots; the display GETs a merged summary. (Formerly Workers KV — its free-tier caps of 1,000 writes and 1,000 lists per day were too tight for the shipped cadences; the DO free tier allows 100k row writes/day, so every push persists as-is with no write budget or list cache.)

- `POST /v1/push`  — `Authorization: Bearer <PUSH_TOKEN>`, body = snapshot v1. Stored per `machineId`; machines silent for 7 days are pruned.
- `GET /v1/summary` — `Authorization: Bearer <READ_TOKEN>`. Merged view; tokens summed across machines, limits from the freshest machine; all times relative (`ageSec`, `resetsInSec`).

Deploy: `npm install && npx wrangler deploy`. Secrets: `npx wrangler secret put PUSH_TOKEN` / `READ_TOKEN`.
Local dev: `npx wrangler dev` with `.dev.vars` containing `PUSH_TOKEN=... READ_TOKEN=...`.
Tokens + URL for the other components live in `~/.config/usage-collector/tokens.json` (created at deploy time, mode 600, not in git).
