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
