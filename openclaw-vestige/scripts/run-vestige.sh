#!/usr/bin/env bash
# Run vestige-mcp with native HTTP transport (no supergateway)
#
# Usage:
#   ./scripts/run-vestige.sh                    # foreground
#   ./scripts/run-vestige.sh --background       # nohup background
#   ./scripts/run-vestige.sh --stop             # kill running instance
#
# Environment:
#   VESTIGE_BIN       Path to vestige-mcp binary (default: search PATH, then ./target/release)
#   VESTIGE_DATA_DIR  Database file path (default: /data/vestige/vestige.db)
#   VESTIGE_HOST      Bind address (default: 127.0.0.1)
#   VESTIGE_PORT      HTTP port (default: 3100)
#   VESTIGE_LOG_DIR   Log directory (default: /data/vestige/logs)
#   RUST_LOG          Log level (default: info)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Defaults ──────────────────────────────────────────────────────────────────

VESTIGE_DATA_DIR="${VESTIGE_DATA_DIR:-/data/vestige/vestige.db}"
VESTIGE_HOST="${VESTIGE_HOST:-127.0.0.1}"
VESTIGE_PORT="${VESTIGE_PORT:-3100}"
VESTIGE_LOG_DIR="${VESTIGE_LOG_DIR:-/data/vestige/logs}"
RUST_LOG="${RUST_LOG:-info}"
PIDFILE="/tmp/vestige-mcp.pid"

# Find the binary
if [ -n "${VESTIGE_BIN:-}" ]; then
    BIN="$VESTIGE_BIN"
elif command -v vestige-mcp &>/dev/null; then
    BIN="$(command -v vestige-mcp)"
elif [ -x "$PROJECT_DIR/../vestige/target/release/vestige-mcp" ]; then
    BIN="$PROJECT_DIR/../vestige/target/release/vestige-mcp"
elif [ -x "/usr/local/bin/vestige-mcp" ]; then
    BIN="/usr/local/bin/vestige-mcp"
else
    echo "ERROR: vestige-mcp binary not found." >&2
    echo "Set VESTIGE_BIN or ensure vestige-mcp is in PATH." >&2
    exit 1
fi

# ── Commands ──────────────────────────────────────────────────────────────────

stop_vestige() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping vestige-mcp (PID $PID)..."
            kill "$PID"
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                echo "Force killing..."
                kill -9 "$PID"
            fi
            rm -f "$PIDFILE"
            echo "Stopped."
        else
            echo "PID $PID not running, cleaning up pidfile."
            rm -f "$PIDFILE"
        fi
    else
        echo "No pidfile found. Checking for running instances..."
        pkill -f "vestige-mcp --http" && echo "Killed." || echo "No running instance found."
    fi
}

run_foreground() {
    echo "Starting vestige-mcp (foreground)"
    echo "  Binary:   $BIN"
    echo "  Data:     $VESTIGE_DATA_DIR"
    echo "  Listen:   http://$VESTIGE_HOST:$VESTIGE_PORT/mcp"
    echo "  Log:      $RUST_LOG"
    echo ""

    RUST_LOG="$RUST_LOG" exec "$BIN" \
        --http \
        --host "$VESTIGE_HOST" \
        --port "$VESTIGE_PORT" \
        --data-dir "$VESTIGE_DATA_DIR"
}

run_background() {
    # Check if already running
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "vestige-mcp already running (PID $PID)."
            echo "Use --stop to kill it first."
            exit 1
        fi
        rm -f "$PIDFILE"
    fi

    mkdir -p "$VESTIGE_LOG_DIR"

    local STDOUT_LOG="$VESTIGE_LOG_DIR/vestige-mcp.stdout.log"
    local STDERR_LOG="$VESTIGE_LOG_DIR/vestige-mcp.stderr.log"

    echo "Starting vestige-mcp (background)"
    echo "  Binary:   $BIN"
    echo "  Data:     $VESTIGE_DATA_DIR"
    echo "  Listen:   http://$VESTIGE_HOST:$VESTIGE_PORT/mcp"
    echo "  Stdout:   $STDOUT_LOG"
    echo "  Stderr:   $STDERR_LOG"
    echo "  Pidfile:  $PIDFILE"
    echo ""

    RUST_LOG="$RUST_LOG" nohup "$BIN" \
        --http \
        --host "$VESTIGE_HOST" \
        --port "$VESTIGE_PORT" \
        --data-dir "$VESTIGE_DATA_DIR" \
        >> "$STDOUT_LOG" 2>> "$STDERR_LOG" &

    echo $! > "$PIDFILE"
    echo "Started (PID $(cat "$PIDFILE"))."

    # Wait a moment and verify
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Healthy — listening on http://$VESTIGE_HOST:$VESTIGE_PORT/mcp"
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
        stop_vestige
        ;;
    --background|-d)
        run_background
        ;;
    *)
        run_foreground
        ;;
esac
