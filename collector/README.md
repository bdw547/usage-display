# usage-collector

Per-machine daemon. Computes Claude Code token totals from `~/.claude/projects/**/*.jsonl`,
reads Claude limit % (`api.anthropic.com/api/oauth/usage`, using Claude Code's own OAuth token),
Codex limit % (`chatgpt.com` usage endpoint, falling back to `~/.codex/sessions` rollout files),
and Copilot premium-request quota (`api.github.com/copilot_internal/user` via `gh auth token`).
Pushes a snapshot to the relay every 30s. Never refreshes vendor tokens (read-only).

## Install on a new machine
1. `git clone` this repo (or copy the `collector/` directory) — Node 22+ required.
2. Create `~/.config/usage-collector/config.json` (chmod 600):
   `{ "relayUrl": "https://usage-relay.<sub>.workers.dev", "pushToken": "<PUSH_TOKEN>" }`
3. Smoke test: `node collector/src/index.js --once --print --no-push`
4. Install the service: `bash collector/install/install.sh`
   (WSL2/headless: also `sudo loginctl enable-linger $USER`)

Sources degrade independently: if Claude Code / Codex / gh isn't present or logged in on a machine,
that section reports null and the freshest other machine wins at the relay.

Logs: `journalctl --user -u usage-collector -f`
