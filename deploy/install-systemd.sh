#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/claude-bridge}"
NODE_BIN="${NODE_BIN:-/opt/nodejs-v24.21.0/bin/node}"
ENV_FILE="${ENV_FILE:-/etc/kilo-bridge/bridge.env}"
CLAUDE_BIN="${CLAUDE_BIN:-/home/ubuntu/.local/bin/claude}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/claude-bridge.service}"

for executable in "$NODE_BIN" "$CLAUDE_BIN"; do
  if [[ "$executable" != /* || ! -x "$executable" ]]; then
    echo "Missing executable: $executable" >&2
    exit 1
  fi
done
if (( $("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])') < 24 )); then
  echo "Claude Bridge requires Node.js >=24" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/src/index.js" || ! -f "$APP_DIR/node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]]; then
  echo "Install the application and npm dependencies in $APP_DIR first" >&2
  exit 1
fi
if ! sudo test -r "$ENV_FILE"; then
  echo "Existing server-side EnvironmentFile is not readable: $ENV_FILE" >&2
  exit 1
fi

# Validate by name without printing values. systemd reads the existing root-owned file.
if ! sudo grep -q '^SUPABASE_URL=' "$ENV_FILE" || ! sudo grep -q '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE"; then
  echo "EnvironmentFile lacks required Supabase server-side variables" >&2
  exit 1
fi

sed -e "s|/opt/claude-bridge|$APP_DIR|g" \
    -e "s|/opt/nodejs-v24.21.0/bin/node|$NODE_BIN|g" \
    -e "s|/etc/kilo-bridge/bridge.env|$ENV_FILE|g" \
    "$APP_DIR/deploy/claude-bridge.service.in" | sudo tee "$UNIT_FILE" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now claude-bridge.service
sudo systemctl --no-pager --full status claude-bridge.service
