# Local Dev Setup

## Option 1: Native HTTP (recommended for bridge)

```bash
# Start vestige-mcp with native HTTP transport
vestige-mcp --http --host 127.0.0.1 --port 3100 &

# Generate and save a token
export VESTIGE_AUTH_TOKEN=$(openssl rand -hex 32)
echo "$VESTIGE_AUTH_TOKEN"
echo "$VESTIGE_AUTH_TOKEN" > /data/vestige/auth-token

# Set the MCP URL for the bridge
export VESTIGE_MCP_URL=http://localhost:3100/mcp

# Start the bridge (make sure you're in the venv)
cd ~/projects/openclaw-vestige/server
source .venv/bin/activate
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 &

# Verify
curl -H "Authorization: Bearer $VESTIGE_AUTH_TOKEN" http://localhost:8000/health
```

## Option 2: stdio (for Claude Code / `claude mcp add`)

```bash
# Add vestige-mcp as a stdio MCP server (no HTTP needed)
claude mcp add vestige -- vestige-mcp

# Or if you want Claude Code to talk to the HTTP endpoint directly:
claude mcp add vestige --url http://localhost:3100/mcp
```
