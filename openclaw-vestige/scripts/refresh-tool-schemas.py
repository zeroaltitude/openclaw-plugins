#!/usr/bin/env python3
"""Refresh server/tests/vestige_tool_schemas.json from a live vestige-mcp.

The engine owns the tool contract; that JSON file is the checked-in copy the
bridge's contract tests validate against (see test_tool_arg_contracts.py).
Re-run this whenever the engine's tool schemas change.

    # against a local engine
    python3 scripts/refresh-tool-schemas.py

    # against the deployed engine (SSH tunnel, since :3100 is not public)
    ssh -N -L 3100:localhost:3100 vestige.bighatbio.me &
    python3 scripts/refresh-tool-schemas.py

Env:
    VESTIGE_MCP_URL   default http://localhost:3100/mcp

Only the tools the bridge actually calls are kept. If a tool disappears from
tools/list the script says so and leaves the entry alone — deciding what the
bridge should call instead is a judgement call, not a mechanical one.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

SNAPSHOT = Path(__file__).resolve().parent.parent / "server" / "tests" / "vestige_tool_schemas.json"
URL = os.environ.get("VESTIGE_MCP_URL", "http://localhost:3100/mcp")


def rpc(method: str, params: dict, session: str | None) -> tuple[dict, str | None]:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **({"Mcp-Session-Id": session} if session else {}),
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read().decode()
        session = response.headers.get("mcp-session-id") or session

    if payload.lstrip().startswith("event:") or payload.lstrip().startswith("data:"):
        payload = next(
            line[5:].strip() for line in payload.splitlines() if line.startswith("data:")
        )
    data = json.loads(payload)
    if "error" in data:
        sys.exit(f"MCP error from {URL}: {data['error']}")
    return data.get("result", {}), session


def main() -> None:
    snapshot = json.loads(SNAPSHOT.read_text())
    wanted = list(snapshot["tools"])

    try:
        _, session = rpc(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "refresh-tool-schemas", "version": "1.0"},
            },
            None,
        )
        result, _ = rpc("tools/list", {}, session)
    except (urllib.error.URLError, OSError) as exc:
        sys.exit(f"Cannot reach vestige-mcp at {URL}: {exc}")

    live = {tool["name"]: tool["inputSchema"] for tool in result.get("tools", [])}

    missing = [name for name in wanted if name not in live]
    for name in missing:
        print(f"WARNING: '{name}' is no longer advertised by tools/list — entry left unchanged")

    snapshot["tools"] = {name: live.get(name, snapshot["tools"][name]) for name in wanted}
    snapshot["_meta"]["captured"] = date.today().isoformat()
    snapshot["_meta"]["source_commit"] = "(refreshed from a live engine — record the commit here)"
    SNAPSHOT.write_text(json.dumps(snapshot, indent=2) + "\n")

    print(f"Wrote {len(wanted) - len(missing)} live schemas to {SNAPSHOT}")
    print("Now run: cd server && pytest tests/test_tool_arg_contracts.py")


if __name__ == "__main__":
    main()
