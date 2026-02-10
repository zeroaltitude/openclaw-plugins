#!/usr/bin/env bash
# Run the FastAPI Vestige bridge
#
# Usage:
#   ./scripts/run-bridge.sh                    # foreground
#   ./scripts/run-bridge.sh --background       # nohup background
#   ./scripts/run-bridge.sh --stop             # kill running instance
#
# Environment:
#   VESTIGE_AUTH_TOKEN   Bearer token for API auth (required, or reads from /data/vestige/auth-token)
#   VESTIGE_MCP_URL      MCP endpoint URL (default: http://localhost:3100/mcp)
#   BRIDGE_HOST          Bind address (default: 127.0.0.1)
#   BRIDGE_PORT          HTTP port (default: 8000)
#   BRIDGE_LOG_DIR       Log directory (default: /data/vestige/logs)
#   LOG_LEVEL            Python log level (default: INFO)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")/server"

# ── Defaults ──────────────────────────────────────────────────────────────────

VESTIGE_MCP_URL="${VESTIGE_MCP_URL:-http://localhost:3100/mcp}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-8000}"
BRIDGE_LOG_DIR="${BRIDGE_LOG_DIR:-/data/vestige/logs}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
PIDFILE="/tmp/vestige-bridge.pid"

# Auth token: env var > file > error
if [ -z "${VESTIGE_AUTH_TOKEN:-}" ]; then
    if [ -f /data/vestige/auth-token ]; then
        VESTIGE_AUTH_TOKEN="$(cat /data/vestige/auth-token)"
    else
        echo "ERROR: VESTIGE_AUTH_TOKEN not set and /data/vestige/auth-token not found." >&2
        echo "Generate one: openssl rand -hex 32" >&2
        exit 1
    fi
fi
export VESTIGE_AUTH_TOKEN VESTIGE_MCP_URL LOG_LEVEL

# Find uvicorn
if [ -x "$SERVER_DIR/.venv/bin/uvicorn" ]; then
    UVICORN="$SERVER_DIR/.venv/bin/uvicorn"
elif command -v uvicorn &>/dev/null; then
    UVICORN="$(command -v uvicorn)"
else
    echo "ERROR: uvicorn not found. Create a venv:" >&2
    echo "  cd $SERVER_DIR && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

# ── Commands ──────────────────────────────────────────────────────────────────

stop_bridge() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping vestige-bridge (PID $PID)..."
            kill "$PID"
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID"
            fi
            rm -f "$PIDFILE"
            echo "Stopped."
        else
            echo "PID $PID not running, cleaning up pidfile."
            rm -f "$PIDFILE"
        fi
    else
        echo "No pidfile found."
        pkill -f "uvicorn app.main:app" && echo "Killed." || echo "No running instance found."
    fi
}

run_foreground() {
    echo "Starting vestige-bridge (foreground)"
    echo "  Server:   $SERVER_DIR"
    echo "  Uvicorn:  $UVICORN"
    echo "  Listen:   http://$BRIDGE_HOST:$BRIDGE_PORT"
    echo "  MCP URL:  $VESTIGE_MCP_URL"
    echo "  Log:      $LOG_LEVEL"
    echo ""

    cd "$SERVER_DIR"
    exec "$UVICORN" app.main:app \
        --host "$BRIDGE_HOST" \
        --port "$BRIDGE_PORT"
}

run_background() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "vestige-bridge already running (PID $PID)."
            echo "Use --stop to kill it first."
            exit 1
        fi
        rm -f "$PIDFILE"
    fi

    mkdir -p "$BRIDGE_LOG_DIR"

    local STDOUT_LOG="$BRIDGE_LOG_DIR/vestige-bridge.stdout.log"
    local STDERR_LOG="$BRIDGE_LOG_DIR/vestige-bridge.stderr.log"

    echo "Starting vestige-bridge (background)"
    echo "  Server:   $SERVER_DIR"
    echo "  Uvicorn:  $UVICORN"
    echo "  Listen:   http://$BRIDGE_HOST:$BRIDGE_PORT"
    echo "  MCP URL:  $VESTIGE_MCP_URL"
    echo "  Stdout:   $STDOUT_LOG"
    echo "  Stderr:   $STDERR_LOG"
    echo "  Pidfile:  $PIDFILE"
    echo ""

    cd "$SERVER_DIR"
    nohup "$UVICORN" app.main:app \
        --host "$BRIDGE_HOST" \
        --port "$BRIDGE_PORT" \
        >> "$STDOUT_LOG" 2>> "$STDERR_LOG" &

    echo $! > "$PIDFILE"
    echo "Started (PID $(cat "$PIDFILE"))."

    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Healthy — listening on http://$BRIDGE_HOST:$BRIDGE_PORT"
    else
        echo "ERROR: Process exited immediately. Check $STDERR_LOG" >&2
        tail -20 "$STDERR_LOG" 2>/dev/null
        rm -f "$PIDFILE"
        exit 1
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

case "${1:-}" in
    --stop)
        stop_bridge
        ;;
    --background|-d)
        run_background
        ;;
    *)
        run_foreground
        ;;
esac
