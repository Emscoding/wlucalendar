Permanent Cloudflare Tunnel — how this repo helps

This directory contains helper templates and a small script to create a named Cloudflare Tunnel (persistent hostname) that forwards requests to your local app running on port 3000.

Important: the commands below run on your machine and require you to authenticate with Cloudflare. I cannot perform these steps for you because they require your Cloudflare account access and will write credentials locally (~/.cloudflared).

Files
- `config.yml.example` — example config you can copy to `~/.cloudflared/config.yml` after creating a tunnel.
- `create_named_tunnel.sh` — helper script to run `cloudflared tunnel login`, `tunnel create`, route DNS, and write a local config. Run it on your Mac.

Quick flow (copy/paste on your machine)
1. Install cloudflared (Homebrew):
   brew install cloudflare/cloudflare/cloudflared

2. Make this script executable and run it:
   chmod +x ./cloudflared/create_named_tunnel.sh
   ./cloudflared/create_named_tunnel.sh

3. Follow prompts: the script will open a browser for `cloudflared tunnel login`, create a named tunnel, and ask you for the domain/subdomain you want to use. It will not modify DNS for you — you'll need to add a CNAME pointing your subdomain to `cftunnel.<your-tunnel-id>.trycloudflare.com` OR let the script attempt `cloudflared tunnel route dns` if you provide Cloudflare account access via the browser login.

Afterwards
- Start the tunnel as a background service (macOS):
  brew services start cloudflare/cloudflare/cloudflared
- Or run the tunnel manually for debugging:
  cloudflared tunnel run <TUNNEL_NAME>

Security
- The script will create a credentials JSON under `~/.cloudflared`. Keep that file private.
