# EC2 Quick-Start Deployment Guide

**Date:** 2026-02-06  
**Author:** Tabitha  
**Status:** Ready — all components available  
**Purpose:** Get Vestige running on a single EC2 instance for hands-on exploration before k8s deployment.

---

## Architecture

```
Internet (HTTPS)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  Caddy (reverse proxy, auto Let's Encrypt HTTPS)     │
│  :443                                                │
│                                                      │
│  ┌─── /mcp* ──────────────────┐                      │
│  │   supergateway :3100       │  ← Claude Code, MCP  │
│  │   └─ vestige-mcp (stdio)  │     clients, Vestige  │
│  │                            │     UI                │
│  └────────────────────────────┘                      │
│                                                      │
│  ┌─── /api/* ─────────────────┐                      │
│  │   FastAPI bridge :8000     │  ← OpenClaw agents   │
│  │   (auth, ACL, identity)    │     (via plugin)     │
│  │   └─ proxies to :3100     │                      │
│  └────────────────────────────┘                      │
└──────────────────────────────────────────────────────┘
```

**Key points:**
- Everything except Caddy binds to `127.0.0.1` (localhost only)
- Caddy handles all HTTPS/TLS (auto Let's Encrypt)
- **Claude Code** connects directly to supergateway at `/mcp` (native MCP, no bridge needed)
- **OpenClaw agents** connect through the FastAPI bridge at `/api/*` (auth + ACL + identity tracking)
- **Vestige UI** accessible through Caddy (if applicable)
- Three paths, one public HTTPS endpoint

## Why the FastAPI Bridge Still Matters

Supergateway exposes Vestige over HTTP — but it has no auth, no ACL, no agent identity tracking. For Claude Code on your laptop, that's fine (local trust). For OpenClaw agents hitting a public endpoint, you need:

1. **Auth** — Bearer token verification (supergateway has none)
2. **ACL** — Namespace-based memory scoping (Phase 2)
3. **Identity** — `X-Agent-Id` / `X-User-Id` tracking (who wrote what)

The bridge handles all three. Supergateway is the raw MCP transport; the bridge is the governed access layer.

---

## Prerequisites

- EC2 instance with public IP (t3.medium or larger recommended)
- Security group: open ports 80 and 443 (Caddy needs both for Let's Encrypt)
- DNS A record pointing at the public IP (e.g., `vestige.yourdomain.com`)
- Ubuntu 22.04+ or Amazon Linux 2023

---

## Step 1: Install Dependencies

```bash
# System packages
sudo apt update && sudo apt install -y build-essential curl git pkg-config libssl-dev

# Rust (for building vestige from source)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# Node.js 22 (for supergateway)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Python 3.12 + pip (for FastAPI bridge)
sudo apt install -y python3.12 python3.12-venv python3-pip

# Caddy (auto-HTTPS reverse proxy)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

## Step 2: Build & Install Vestige

```bash
# Option A: Build from source (requires GLIBC 2.38+ / GCC 13+)
git clone https://github.com/samvallad33/vestige.git /opt/vestige-src
cd /opt/vestige-src
cargo build --release
sudo cp target/release/vestige-mcp target/release/vestige target/release/vestige-restore /usr/local/bin/

# Option B: Download pre-built binary (if your OS has GLIBC 2.38+)
# x86_64 only — no aarch64 pre-built binaries available (build from source for Graviton)
curl -L https://github.com/samvallad33/vestige/releases/latest/download/vestige-mcp-x86_64-unknown-linux-gnu.tar.gz | tar -xz
sudo mv vestige-mcp vestige vestige-restore /usr/local/bin/

# Verify it's in PATH — this is critical, supergateway will fail silently if not found
vestige-mcp --version
which vestige-mcp
# Should output: /usr/local/bin/vestige-mcp
```

> **⚠️ PATH is critical.** Supergateway spawns `vestige-mcp` as a child process. If the binary
> isn't in PATH, supergateway will exit with code 1 and no obvious error message. Always verify
> with `which vestige-mcp` before proceeding. If you installed to a non-standard location,
> use the full path in the supergateway command (Step 4).

## Step 3: Create Data Directory

```bash
sudo mkdir -p /data/vestige
sudo chown $USER:$USER /data/vestige
```

## Step 4: Start Supergateway (Vestige over Streamable HTTP)

```bash
# Install supergateway globally
sudo npm install -g supergateway

# Run (binds to localhost only)
# If vestige-mcp is in PATH:
supergateway \
  --stdio "vestige-mcp --data-dir /data/vestige" \
  --port 3100 \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --healthEndpoint /health &

# If vestige-mcp is NOT in PATH, use the full path:
# supergateway \
#   --stdio "/usr/local/bin/vestige-mcp --data-dir /data/vestige" \
#   --port 3100 \
#   --outputTransport streamableHttp \
#   --streamableHttpPath /mcp \
#   --healthEndpoint /health &

# Verify
curl http://localhost:3100/health
# → "ok"
```

> **⚠️ If supergateway exits immediately with code 1**, check:
> 1. Is `vestige-mcp` in PATH? (`which vestige-mcp`)
> 2. Check stderr: if running via nohup, look at your stderr log file
> 3. Try running vestige-mcp standalone first: `echo '{}' | vestige-mcp --data-dir /data/vestige`

**First boot note:** Vestige will download the Nomic Embed model (~130MB) on the first request. This takes 1-3 minutes depending on bandwidth. Subsequent boots use the cached model.

## Step 5: Start the FastAPI Bridge

```bash
# Clone the repo
git clone https://github.com/BigHat-Biosciences/openclaw-vestige.git /opt/openclaw-vestige
cd /opt/openclaw-vestige/server

# Create a Python virtual environment — DO NOT use system Python
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# If requirements.txt is missing or incomplete, install core deps directly:
# pip install fastapi uvicorn httpx pydantic

# Verify the venv is active (should show .venv path, not /usr/bin)
which uvicorn
# → /opt/openclaw-vestige/server/.venv/bin/uvicorn

# Generate an auth token
export VESTIGE_AUTH_TOKEN=$(openssl rand -hex 32)
echo "Auth token: $VESTIGE_AUTH_TOKEN"
echo "$VESTIGE_AUTH_TOKEN" > /data/vestige/auth-token  # save it

# Configure bridge to connect to supergateway
export VESTIGE_MCP_URL=http://localhost:3100/mcp

# Start — use the venv's uvicorn, NOT the system one
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 &

# Verify
curl -H "Authorization: Bearer $VESTIGE_AUTH_TOKEN" http://localhost:8000/health
```

> **⚠️ Common mistake: using system Python/uvicorn.** If you see `ModuleNotFoundError: No module named 'fastapi'`,
> you're running the system uvicorn instead of the venv one. Always activate the venv first
> (`source .venv/bin/activate`) or use the full path (`.venv/bin/uvicorn`). The system Python on
> Ubuntu does NOT have FastAPI installed.

## Step 6: Configure Caddy (HTTPS)

```bash
sudo tee /etc/caddy/Caddyfile << 'EOF'
vestige.yourdomain.com {
    # Claude Code / native MCP access
    # (No auth — restrict by IP or add basic_auth if needed)
    # flush_interval -1 is REQUIRED for MCP Streamable HTTP (SSE streaming)
    handle /mcp* {
        reverse_proxy localhost:3100 {
            flush_interval -1
        }
    }

    # OpenClaw agent API (bridge handles bearer auth)
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy localhost:8000
    }

    # Health check
    handle /health {
        reverse_proxy localhost:3100
    }
}
EOF

# Restart Caddy (auto-provisions Let's Encrypt cert)
sudo systemctl restart caddy
```

Make sure your DNS A record points to the EC2 public IP. Caddy will automatically obtain and renew the TLS certificate.

## Step 7: Connect Claude Code (Native MCP)

On your local machine:

```bash
claude mcp add vestige --url https://vestige.yourdomain.com/mcp
```

Restart Claude Code. Test:

> "Remember that I prefer TypeScript over JavaScript"

New session:

> "What are my coding preferences?"

It remembers. 🧠

## Step 8: Configure OpenClaw Plugin

In your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-vestige": {
        "enabled": true,
        "config": {
          "serverUrl": "https://vestige.yourdomain.com/api",
          "authToken": "<your-token-from-step-5>"
        }
      }
    }
  }
}
```

Install the plugin from the repo's `plugin/` directory.

---

## Running as systemd Services (Production-ish)

For persistence across reboots:

### supergateway.service

```bash
sudo tee /etc/systemd/system/supergateway.service << 'EOF'
[Unit]
Description=Supergateway (Vestige MCP over Streamable HTTP)
After=network.target

[Service]
Type=simple
User=ubuntu
Environment=FASTEMBED_CACHE_PATH=/data/vestige/.cache/vestige/fastembed
ExecStart=/usr/bin/npx supergateway --stdio "vestige-mcp --data-dir /data/vestige" --port 3100 --outputTransport streamableHttp --streamableHttpPath /mcp --healthEndpoint /health
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### vestige-bridge.service

```bash
sudo tee /etc/systemd/system/vestige-bridge.service << 'EOF'
[Unit]
Description=OpenClaw Vestige Bridge (FastAPI)
After=supergateway.service
Requires=supergateway.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/openclaw-vestige/server
Environment=VESTIGE_AUTH_TOKEN=<your-token>
Environment=VESTIGE_MCP_URL=http://localhost:3100/mcp
ExecStart=/opt/openclaw-vestige/server/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now supergateway vestige-bridge
```

---

## Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Vestige alive | `curl localhost:3100/health` | `"ok"` |
| Bridge alive | `curl -H "Auth..." localhost:8000/health` | `{"status":"healthy",...}` |
| HTTPS working | `curl https://vestige.yourdomain.com/health` | `"ok"` |
| MCP endpoint | `curl -X POST https://vestige.yourdomain.com/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` | Tool list |
| Bridge search | `curl -X POST https://vestige.yourdomain.com/api/search -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"query":"test"}'` | Search results |
| Claude Code | `claude mcp add vestige --url https://vestige.yourdomain.com/mcp` | Connected |

---

## Security Notes

- **Supergateway has no auth.** It's bound to localhost and accessed either directly (Claude Code via Caddy) or through the bridge. If you want to restrict direct MCP access, add Caddy `basic_auth` or IP allowlisting on the `/mcp*` route.
- **The bridge enforces bearer auth** on all `/api/*` routes. Token is required.
- **Caddy auto-HTTPS** handles TLS certificates and renewal. No manual cert management.
- **SQLite data** lives in `/data/vestige/`. Back up this directory regularly (cron + `cp` or EBS snapshots).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `vestige-mcp: command not found` | Ensure it's in PATH: `which vestige-mcp` or use full path in supergateway `--stdio` arg |
| Supergateway exits with code 1 immediately | Almost always: `vestige-mcp` not in PATH. Check stderr log. |
| `ModuleNotFoundError: No module named 'fastapi'` | You're using system Python, not the venv. Run `source .venv/bin/activate` or use `.venv/bin/uvicorn` |
| `curl: transfer closed with outstanding read data remaining` | Supergateway crashed mid-response. Check if process is still running (`ps aux | grep supergateway`) |
| First request hangs (~2 min) | Normal — downloading Nomic Embed model (~130MB). Check `FASTEMBED_CACHE_PATH`. |
| Caddy fails to get cert | Ensure ports 80+443 are open in security group AND DNS A record resolves to the EC2 public IP |
| Claude Desktop: `SSE stream disconnected` | Caddy is buffering SSE responses. Add `flush_interval -1` to the reverse_proxy block (see Step 6) |
| Bridge can't reach supergateway | Check `VESTIGE_MCP_URL` env var. Verify supergateway is running: `curl localhost:3100/health` |
| GLIBC version error | Pre-built binary needs GLIBC 2.38+. Use Ubuntu 24.04 or build from source. |
| Pre-built binary on Graviton/ARM | No aarch64 pre-built binaries available. Must build from source with `cargo build --release`. |
