#!/usr/bin/env bash
set -euo pipefail

# Helper to create a named cloudflared tunnel and route DNS for a subdomain
# Run this locally. It will open a browser for login during `cloudflared tunnel login`.

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi

echo "1) Logging into Cloudflare (opens browser)..."
cloudflared tunnel login

read -p "2) Tunnel name to create (e.g. a9-tunnel): " TUNNEL_NAME
TUNNEL_ID=$(cloudflared tunnel create "$TUNNEL_NAME" | sed -n 's/Created tunnel //p' || true)
if [ -z "$TUNNEL_ID" ]; then
  # Fallback: parse the usual output
  TUNNEL_ID=$(ls -1 ~/.cloudflared | head -n1 || true)
fi
echo "Created tunnel: $TUNNEL_NAME (ID: $TUNNEL_ID)"

read -p "3) Which hostname do you want to map? (subdomain.yourdomain.com): " HOSTNAME

echo "Attempting to route DNS for $HOSTNAME to tunnel $TUNNEL_NAME..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || echo "Routing may require additional permissions; if it fails, add the DNS record yourself in Cloudflare dashboard."

CFG_DIR="$HOME/.cloudflared"
CFG_FILE="$CFG_DIR/config.yml"
mkdir -p "$CFG_DIR"
cat > "$CFG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:3000
  - service: http_status:404
EOF

echo "Wrote config to $CFG_FILE"
echo "Run: cloudflared tunnel run $TUNNEL_NAME"
echo "To run as a service on macOS: brew services start cloudflare/cloudflare/cloudflared"
