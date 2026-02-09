nohup uvicorn app.main:app --host 127.0.0.1 --port 8000 >~/fastapi.stdout 2>~/fastapi.stderr &

export VESTIGE_MCP_URL=http://localhost:3100/mcp
export VESTIGE_AUTH_TOKEN=$(cat /data/vestige/auth-token)
VESTIGE_MCP_URL=http://localhost:3100/mcp VESTIGE_AUTH_TOKEN=$(cat /data/vestige/auth-token) nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 >~/fastapi.stdout 2>~/fastapi.stderr &
