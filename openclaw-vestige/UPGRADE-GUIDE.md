# Vestige 2.0 Upgrade Guide

**For:** vestige.bighatbio.me (EC2 instance)
**Date:** 2026-02-27

This is a 4-step upgrade. Each step is independently safe — the stack is backward compatible, so you can verify at each stage.

---

## Step 1: Build the new vestige-mcp binary

SSH into the EC2 instance, pull the updated code, and build:

```bash
ssh vestige-server  # however you connect

cd ~/projects/vestige
git fetch origin
git checkout feat/http-mcp
git pull origin feat/http-mcp

# Verify the Cargo.toml fix (should show single unified axum entry)
grep "axum" crates/vestige-mcp/Cargo.toml

# Build release binary
cargo build --release -p vestige-mcp

# Verify it built
./target/release/vestige-mcp --version
# Should show: vestige-mcp 2.0.0
```

## Step 2: Swap the vestige-mcp binary and restart

```bash
# Stop the old processes
pkill -f supergateway   # kill the old supergateway wrapper (no longer needed)
pkill -f vestige-mcp    # kill the old binary

# Back up old binary (just in case)
cp ~/.local/bin/vestige-mcp ~/.local/bin/vestige-mcp.v1-backup

# Install new binary
cp target/release/vestige-mcp ~/.local/bin/vestige-mcp
cp target/release/vestige ~/.local/bin/vestige
cp target/release/vestige-restore ~/.local/bin/vestige-restore

# Start vestige-mcp with NATIVE HTTP (no more supergateway!)
nohup vestige-mcp --http --host 127.0.0.1 --port 3100 \
  --data-dir /data/vestige/vestige.db \
  > ~/vestige-mcp.stdout 2> ~/vestige-mcp.stderr &

# Verify it's running and shows 2.0 tools
curl http://localhost:3100/health
# Check logs for tool list:
head -20 ~/vestige-mcp.stderr
# Should list: search, smart_ingest, memory, codebase, intention, dream,
#   session_context, explore_connections, predict, importance_score,
#   consolidate, etc.
```

**What changed:** We no longer need `supergateway` as a wrapper. The new binary has native HTTP Streamable transport built in (our `feat/http-mcp` branch). Same port, same `/mcp` path — Caddy config doesn't change.

## Step 3: Update the FastAPI bridge and restart

```bash
cd ~/projects/openclaw-plugins/openclaw-vestige/server

# Pull the updated code (models.py + main.py changes)
git pull  # or however you sync the code to the server

# Activate venv
source .venv/bin/activate

# Kill old bridge
pkill -f uvicorn

# Start updated bridge
export VESTIGE_MCP_URL=http://localhost:3100/mcp
export VESTIGE_AUTH_TOKEN=$(cat /data/vestige/auth-token)
nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  > ~/fastapi.stdout 2> ~/fastapi.stderr &

# Verify — old endpoints still work
curl -s -H "Authorization: Bearer $VESTIGE_AUTH_TOKEN" \
  -X POST http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "limit": 3}' | python3 -m json.tool

# Verify — new endpoints work
curl -s -H "Authorization: Bearer $VESTIGE_AUTH_TOKEN" \
  -X POST http://localhost:8000/dream \
  -H "Content-Type: application/json" \
  -d '{"memory_count": 10}' | python3 -m json.tool

# Verify all 14 POST endpoints are registered
curl -s http://localhost:8000/openapi.json | python3 -c "
import json, sys
spec = json.load(sys.stdin)
posts = [p for p, methods in spec['paths'].items() if 'post' in methods]
posts.sort()
print(f'{len(posts)} POST endpoints:')
for p in posts: print(f'  {p}')
"
```

## Step 4: Caddyfile — NO CHANGES NEEDED

The current Caddyfile already handles everything correctly:

```
vestige.bighatbio.me {
    handle /mcp* {
        reverse_proxy localhost:3100    # vestige-mcp native HTTP (was supergateway)
    }
    handle /api/* {
        uri strip_prefix /api
        reverse_proxy localhost:8000    # FastAPI bridge (new endpoints auto-exposed)
    }
    handle /health {
        reverse_proxy localhost:3100
    }
}
```

- Port 3100 is still vestige-mcp (just native HTTP now instead of supergateway)
- Port 8000 is still the FastAPI bridge (new endpoints are just more routes)
- No new paths needed — the bridge handles routing internally

## Step 5: Verify end-to-end from OpenClaw

After Eddie restarts the OpenClaw gateway to pick up the new plugin (v0.3.0):

```bash
# On the OpenClaw host, restart to load new plugin tools
openclaw gateway restart
```

Then test from any agent session:
- `vestige_search` — should work (unchanged)
- `vestige_dream` — NEW, should trigger dream consolidation
- `vestige_session_context` — NEW, should return combined session init

---

## Rollback

If anything goes wrong:

```bash
# Restore old binary
cp ~/.local/bin/vestige-mcp.v1-backup ~/.local/bin/vestige-mcp

# Restart with supergateway (old way)
# (supergateway.cmd is renamed to .deprecated in the repo but you can
#  still run the commands manually if needed)
pkill -f vestige-mcp
npx supergateway \
  --stdio "vestige-mcp --data-dir /data/vestige/vestige.db" \
  --port 3100 \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --healthEndpoint /health \
  --stateful \
  --sessionTimeout 300000 &
```

The FastAPI bridge and OpenClaw plugin are backward compatible — old tools still work even if the binary is rolled back.

---

## Summary

| Component | Before | After | Port |
|-----------|--------|-------|------|
| vestige-mcp | v1.x via supergateway | v2.0 native HTTP | 3100 |
| FastAPI bridge | v0.2.0, 9 endpoints | v0.3.0, 14 endpoints | 8000 |
| OpenClaw plugin | v0.2.0, 5 tools | v0.3.0, 11 tools | — |
| Caddy | unchanged | unchanged | 443 |
| supergateway | required | **removed** | — |
