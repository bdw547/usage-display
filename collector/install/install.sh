#!/usr/bin/env bash
# collector/install/install.sh — install the collector as a systemd user service.
set -euo pipefail
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node not found in PATH"; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|__NODE__|$NODE_BIN|" "$(dirname "$0")/usage-collector.service" > "$UNIT_DIR/usage-collector.service"
systemctl --user daemon-reload
systemctl --user enable --now usage-collector.service
systemctl --user status usage-collector.service --no-pager || true
echo
echo "If this machine isn't a desktop session (e.g. headless/WSL), enable lingering so the service"
echo "runs without a login session:  sudo loginctl enable-linger $USER"
