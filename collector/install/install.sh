#!/usr/bin/env bash
# collector/install/install.sh — install the collector as a systemd user service.
# Re-runnable: it always rewrites the unit from this checkout and restarts the service.
set -euo pipefail
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node not found in PATH"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
# The collector directory this script was run from — the unit points at THIS checkout
# instead of a hardcoded ~/usage-display, so any clone path (or a bare collector/ copy)
# works, and re-running after a move fixes the unit.
COLLECTOR_DIR="$(cd "$HERE/.." && pwd)"
[ -f "$COLLECTOR_DIR/src/index.js" ] || { echo "cannot find $COLLECTOR_DIR/src/index.js"; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
# The unit sandbox (ProtectSystem=strict) whitelists this path via ReadWritePaths; systemd
# fails namespace setup (226/NAMESPACE) if it doesn't exist yet, so create it up front.
mkdir -p "$HOME/.local/share/usage-collector"
sed -e "s|__NODE__|$NODE_BIN|" -e "s|__COLLECTOR__|$COLLECTOR_DIR|" \
  "$HERE/usage-collector.service" > "$UNIT_DIR/usage-collector.service"
systemctl --user daemon-reload
systemctl --user enable usage-collector.service
systemctl --user restart usage-collector.service
systemctl --user status usage-collector.service --no-pager || true
echo
echo "Unit ExecStart: $NODE_BIN $COLLECTOR_DIR/src/index.js"
echo
echo "If this machine isn't a desktop session (e.g. headless/WSL), enable lingering so the service"
echo "runs without a login session:  sudo loginctl enable-linger $USER"
