#!/usr/bin/env python3
"""
Trust Audit Script for OpenClaw Sessions
=========================================
Scans session JSONL files for:
1. Sensitive tool usage (credentials, secrets, exec, config changes, messaging)
2. Non-Eddie senders interacting with the agent
3. Potential prompt injection attempts
4. Suspicious or diabolical content patterns

Maintains a heartbeat file to track last audit time and skip already-audited sessions.

Usage:
    python3 trust-audit.py [--full]         # --full ignores heartbeat, scans everything
    python3 trust-audit.py                  # incremental scan since last heartbeat
    python3 trust-audit.py --promptguard    # also run ML prompt injection detection
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

# --- Configuration ---
AGENTS_DIR = Path.home() / ".openclaw" / "agents"
HEARTBEAT_FILE = AGENTS_DIR / ".trust-audit-heartbeat"

# Eddie's known identifiers
EDDIE_IDENTIFIERS = {
    "U010622FNQP",          # Slack user ID
    "159471966640799744",   # Discord user ID
    "eddie",
    "eddie abrams",
    "edward abrams",
    "zeroaltitude",
}

# Trusted agents/bots — these are "us", not external senders
# Include both Slack (U0...) and Discord (numeric) IDs for each agent
TRUSTED_AGENTS = {
    "U0ADE5RMUS0": "Tabitha",           # Tabitha — Slack
    "U0AGLQ6MQRF": "Tank",              # Tank — Slack
    "U0AF45ZACF6": "Telemachus",        # Telemachus — Anisha's agent, Slack
    "U0190KQCEDS": "hatbot",            # hatbot — Slack
    "U0AKRQQ2VT7": "Narcissus",         # Narcissus — Slack
    "1481181964550672430": "Narcissus", # Narcissus — Discord
    "1481529266448629872": "Shiva",     # Shiva — Discord
}
TRUSTED_AGENT_NAMES = {v.lower() for v in TRUSTED_AGENTS.values()}

# Known non-Eddie humans who are authorized in shared channels
KNOWN_AUTHORIZED_HUMANS = {
    "U06T3449W9H": "Anisha Keshavan",
    "U013E6CGU1W": "Jeremy Hert",
}

# Tools considered sensitive
SENSITIVE_TOOLS = {
    "exec": "shell_execution",
    "gateway": "gateway_config",
    "message": "messaging",
    "sessions_send": "cross_session_messaging",
    "sessions_spawn": "agent_spawning",
    "tts": "text_to_speech",
    "browser": "browser_control",
    "web_fetch": "web_access",
    "web_search": "web_search",
    "nodes": "node_control",
    "cron": "cron_management",
}

# High-severity tool patterns (always flag)
HIGH_SEVERITY_TOOLS = {"gateway", "nodes", "sessions_send", "sessions_spawn", "cron"}

# Patterns suggesting credential/secret access in exec commands
CREDENTIAL_PATTERNS = [
    re.compile(r"op\s+(read|get|item)", re.IGNORECASE),
    re.compile(r"1password|op-get-value", re.IGNORECASE),
    re.compile(r"\.ssh/id_rsa|authorized_keys", re.IGNORECASE),
    re.compile(r"curl.*(-H|--header).*auth", re.IGNORECASE),
]

# Patterns that look like actual secret values (not discussions about secrets)
# Used for scanning assistant responses for leaked credentials
LEAKED_SECRET_PATTERNS = [
    # Actual token/key values — must be full unredacted tokens (no ... ellipsis)
    # Slack tokens: xoxb- followed by 30+ contiguous chars (redacted ones have "..." breaks)
    re.compile(r"xox[bpras]-[A-Za-z0-9\-]{30,}", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9]{20,}", re.IGNORECASE),  # OpenAI-style keys
    re.compile(r"ghp_[A-Za-z0-9]{36,}", re.IGNORECASE),  # GitHub PATs
    re.compile(r"AKIA[A-Z0-9]{16}", re.IGNORECASE),  # AWS access keys
    re.compile(r"Bearer\s+[A-Za-z0-9\-_.~+/]{30,}", re.IGNORECASE),  # Bearer tokens
    re.compile(r"-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----", re.IGNORECASE),  # Private keys
]

# Patterns suggesting prompt injection or manipulation
# NOTE: These are tuned to avoid false positives from discussing security features
INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(previous|prior|all|above)\s+(instructions?|prompts?|rules?)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(a|an|the|my)\s+\w+\s+(assistant|ai|bot|agent)", re.IGNORECASE),
    re.compile(r"(system|admin)\s*:\s*override", re.IGNORECASE),
    re.compile(r"forget\s+(your|all|every)\s+(instructions?|rules?|constraints?)", re.IGNORECASE),
    re.compile(r"(pretend|act\s+as\s+if)\s+you\s+(are|have|can)\s+(not\s+)?bound", re.IGNORECASE),
    re.compile(r"do\s+not\s+follow\s+(your|the|any)\s+(rules?|instructions?|guidelines?)", re.IGNORECASE),
    re.compile(r"(reveal|show|tell|give)\s+(me\s+)?(your|the|all)\s*(system\s*prompt|api\s*key|password|private\s*key)", re.IGNORECASE),
    # "developer mode" only when it looks like an injection, not a feature discussion
    re.compile(r"(enter|activate|enable|switch\s+to)\s+(DAN|developer|unrestricted|jailbreak)\s*mode", re.IGNORECASE),
    re.compile(r"bypass\s+(your\s+)?(security|safety|filter|restriction|guard)", re.IGNORECASE),
    re.compile(r"(send|forward|email|post|share)\s+(eddie|user|owner).*?(credentials?|password|secret|private\s*key)", re.IGNORECASE),
    re.compile(r"(exfiltrate|steal|extract|leak)\s+(data|info|credentials?|secrets?)", re.IGNORECASE),
]

# Patterns for inappropriate/diabolical content
# Tuned to avoid false positives from legitimate discussions (crypto = cryptocurrency discussion,
# "cryptographically signed" = security feature discussion)
DIABOLICAL_PATTERNS = [
    re.compile(r"(rm\s+-rf\s+(/|\~|/home))", re.IGNORECASE),  # destructive rm only on dangerous paths
    re.compile(r"(harm|hurt|attack|exploit|compromise)\s+(the\s+)?(user|owner|eddie|system|server)", re.IGNORECASE),
    re.compile(r"(social\s+engineer|manipulate|deceive|trick)\s+(the\s+)?(user|owner|eddie|admin)", re.IGNORECASE),
    re.compile(r"(send|post|share)\s+(eddie'?s?\s+)?(private|personal|confidential)\s+(data|info|messages?|files?)\s+(to|with)\s+", re.IGNORECASE),
    # Only flag crypto when it looks like a scam/theft, not discussion
    re.compile(r"(send|transfer|wire)\s+(bitcoin|crypto|eth|funds)\s+to\s+", re.IGNORECASE),
    re.compile(r"(phishing|malware|ransomware|backdoor|rootkit|keylogger)\s+(attack|campaign|payload|install)", re.IGNORECASE),
]


def load_heartbeat() -> float | None:
    """Load the last audit timestamp. Returns None if no heartbeat exists."""
    if HEARTBEAT_FILE.exists():
        try:
            data = json.loads(HEARTBEAT_FILE.read_text())
            return data.get("last_audit_epoch")
        except (json.JSONDecodeError, KeyError):
            return None
    return None


def save_heartbeat():
    """Save current timestamp as heartbeat."""
    now = time.time()
    data = {
        "last_audit_epoch": now,
        "last_audit_iso": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
    }
    HEARTBEAT_FILE.write_text(json.dumps(data, indent=2) + "\n")


def classify_sender(name: str, sender_id: str | None) -> str:
    """Classify a sender as 'eddie', 'trusted_agent', 'authorized_human', 'system', or 'unknown_external'."""
    if sender_id and sender_id in EDDIE_IDENTIFIERS:
        return "eddie"
    if name.lower() in EDDIE_IDENTIFIERS:
        return "eddie"
    if sender_id and sender_id in TRUSTED_AGENTS:
        return "trusted_agent"
    if name.lower() in TRUSTED_AGENT_NAMES:
        return "trusted_agent"
    if sender_id and sender_id in KNOWN_AUTHORIZED_HUMANS:
        return "authorized_human"
    if name.lower() in {n.lower() for n in KNOWN_AUTHORIZED_HUMANS.values()}:
        return "authorized_human"
    if name == "system/cron":
        return "system"
    return "unknown_external"


def identify_sender(text: str, agent_name: str | None = None) -> dict:
    """Extract sender info from user message text.
    agent_name: the agent directory name (e.g. 'main', 'tank') for context."""
    info = {"is_eddie": False, "is_trusted": False, "sender_name": "unknown",
            "sender_id": None, "channel": None, "classification": "unknown_external"}

    # Look for "Slack DM from X" or "Slack message in #channel from X"
    dm_match = re.search(r"(?:Slack (?:DM|message).*?from)\s+([A-Za-z][\w\s]+?)(?::|$|\n)", text)
    if dm_match:
        info["sender_name"] = dm_match.group(1).strip()

    # Also try "Sender" label in JSON metadata
    if info["sender_name"] == "unknown":
        label_match = re.search(r'"label"\s*:\s*"([^"]+)"', text)
        if label_match:
            info["sender_name"] = label_match.group(1).strip()

    # Look for sender_id in metadata
    sid_match = re.search(r'"sender_id"\s*:\s*"(\w+)"', text)
    if sid_match:
        info["sender_id"] = sid_match.group(1)

    # Look for sender in metadata (fallback)
    sender_match = re.search(r'"sender"\s*:\s*"(\w+)"', text)
    if sender_match and not info["sender_id"]:
        info["sender_id"] = sender_match.group(1)

    # Look for channel
    ch_match = re.search(r'channel:\s*(\w+)', text)
    if ch_match:
        info["channel"] = ch_match.group(1)

    # Cron/system messages
    if text.startswith("[cron:") or text.startswith("[System") or text.startswith("GatewayRestart:"):
        info["sender_name"] = "system/cron"

    # Heartbeat messages (system-generated, not external)
    if re.match(r'^Read HEARTBEAT\.md|^HEARTBEAT', text[:30]):
        info["sender_name"] = "system/cron"

    # If no metadata found and this is a main session, assume Eddie (owner)
    # Main sessions without Slack metadata are direct CLI/DM interactions
    if info["sender_name"] == "unknown" and info["sender_id"] is None and agent_name == "main":
        info["sender_name"] = "Eddie Abrams (inferred)"
        info["classification"] = "eddie"
        info["is_eddie"] = True
        info["is_trusted"] = True
        return info

    # Classify
    info["classification"] = classify_sender(info["sender_name"], info["sender_id"])
    info["is_eddie"] = info["classification"] == "eddie"
    info["is_trusted"] = info["classification"] in ("eddie", "trusted_agent", "authorized_human", "system")

    return info


def check_tool_sensitivity(tool_name: str, arguments: dict) -> list[dict]:
    """Check a tool call for sensitive operations. Returns list of findings."""
    findings = []

    if tool_name not in SENSITIVE_TOOLS:
        return findings

    severity = "high" if tool_name in HIGH_SEVERITY_TOOLS else "medium"

    if tool_name == "exec":
        cmd = arguments.get("command", "")
        for pattern in CREDENTIAL_PATTERNS:
            if pattern.search(cmd):
                findings.append({
                    "type": "credential_access",
                    "severity": "high",
                    "tool": tool_name,
                    "detail": f"Credential pattern in exec: {cmd[:200]}",
                })
                break
        else:
            # Still log exec but as lower severity for dangerous commands
            if any(kw in cmd.lower() for kw in ["sudo", "chmod 777", "ssh ", "scp "]):
                findings.append({
                    "type": "sensitive_exec",
                    "severity": "medium",
                    "tool": tool_name,
                    "detail": f"Sensitive command: {cmd[:200]}",
                })

    elif tool_name == "gateway":
        action = arguments.get("action", "")
        if action in ("config.apply", "config.patch", "update.run", "restart"):
            findings.append({
                "type": "gateway_modification",
                "severity": "high",
                "tool": tool_name,
                "detail": f"Gateway {action}",
            })

    elif tool_name == "message":
        action = arguments.get("action", "")
        target = arguments.get("target", arguments.get("to", ""))
        findings.append({
            "type": "messaging",
            "severity": severity,
            "tool": tool_name,
            "detail": f"message.{action} to={target}",
        })

    elif tool_name in ("sessions_send", "sessions_spawn"):
        findings.append({
            "type": "session_control",
            "severity": "high",
            "tool": tool_name,
            "detail": f"{tool_name}: {json.dumps(arguments)[:200]}",
        })

    elif tool_name == "cron":
        action = arguments.get("action", "")
        findings.append({
            "type": "cron_management",
            "severity": "high" if action in ("add", "update", "remove") else "medium",
            "tool": tool_name,
            "detail": f"cron.{action}",
        })

    else:
        findings.append({
            "type": "sensitive_tool",
            "severity": severity,
            "tool": tool_name,
            "detail": f"{tool_name}: {json.dumps(arguments)[:150]}",
        })

    return findings


def check_text_for_threats(text: str, role: str = "user") -> list[dict]:
    """Scan text content for injection, manipulation, or diabolical patterns.
    For assistant role, checks for leaked secrets instead of injection patterns."""
    findings = []

    if role == "assistant":
        # Only check for actual leaked secret values, not discussions about secrets
        for pattern in LEAKED_SECRET_PATTERNS:
            match = pattern.search(text)
            if match:
                context_start = max(0, match.start() - 20)
                context_end = min(len(text), match.end() + 20)
                findings.append({
                    "type": "leaked_secret",
                    "severity": "critical",
                    "detail": f"Possible secret value in response: ...{text[context_start:context_end]}...",
                })
                break  # One finding per response is enough
        return findings

    # For user messages: check injection and diabolical patterns
    for pattern in INJECTION_PATTERNS:
        match = pattern.search(text)
        if match:
            context_start = max(0, match.start() - 40)
            context_end = min(len(text), match.end() + 40)
            findings.append({
                "type": "prompt_injection",
                "severity": "critical",
                "detail": f"Injection pattern: ...{text[context_start:context_end]}...",
            })

    for pattern in DIABOLICAL_PATTERNS:
        match = pattern.search(text)
        if match:
            context_start = max(0, match.start() - 40)
            context_end = min(len(text), match.end() + 40)
            findings.append({
                "type": "diabolical_content",
                "severity": "critical",
                "detail": f"Suspicious pattern: ...{text[context_start:context_end]}...",
            })

    return findings


def audit_session(filepath: Path) -> dict:
    """Audit a single session file. Returns a report dict."""
    report = {
        "file": str(filepath),
        "session_id": filepath.stem,
        "agent": filepath.parent.parent.name,
        "senders": defaultdict(int),        # sender_name -> message count
        "sender_classifications": defaultdict(lambda: defaultdict(int)),  # classification -> name -> count
        "non_trusted_senders": [],          # list of truly unknown/untrusted senders
        "tool_findings": [],                # sensitive tool usage
        "threat_findings": [],              # injection/manipulation attempts
        "message_count": 0,
        "tool_call_count": 0,
        "started": None,
        "last_activity": None,
    }

    try:
        with open(filepath) as f:
            for line_num, line in enumerate(f, 1):
                try:
                    obj = json.loads(line.strip())
                except json.JSONDecodeError:
                    continue

                obj_type = obj.get("type")
                timestamp = obj.get("timestamp")

                # Track session timing
                if timestamp:
                    if report["started"] is None:
                        report["started"] = timestamp
                    report["last_activity"] = timestamp

                if obj_type == "message" and "message" in obj:
                    msg = obj["message"]
                    role = msg.get("role", "")
                    content = msg.get("content", [])

                    # Extract text content
                    full_text = ""
                    if isinstance(content, str):
                        full_text = content
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict):
                                if block.get("type") == "text":
                                    full_text += block.get("text", "") + "\n"
                                elif block.get("type") == "toolCall":
                                    report["tool_call_count"] += 1
                                    tool_name = block.get("name", "")
                                    tool_args = block.get("arguments", {})
                                    tool_findings = check_tool_sensitivity(tool_name, tool_args)
                                    for f_item in tool_findings:
                                        f_item["line"] = line_num
                                        f_item["timestamp"] = timestamp
                                    report["tool_findings"].extend(tool_findings)

                    if role == "user":
                        report["message_count"] += 1
                        sender = identify_sender(full_text, agent_name=report["agent"])
                        report["senders"][sender["sender_name"]] += 1
                        report["sender_classifications"][sender["classification"]][sender["sender_name"]] += 1

                        # Only flag truly unknown/untrusted external senders
                        if sender["classification"] == "unknown_external" and sender["sender_name"] != "unknown":
                            report["non_trusted_senders"].append({
                                "name": sender["sender_name"],
                                "id": sender["sender_id"],
                                "channel": sender["channel"],
                                "preview": full_text[:200],
                                "line": line_num,
                                "timestamp": timestamp,
                            })

                        # Scan user messages for threats — only from non-Eddie senders
                        if not sender["is_eddie"]:
                            threats = check_text_for_threats(full_text, role="user")
                            for t in threats:
                                t["line"] = line_num
                                t["timestamp"] = timestamp
                                t["sender"] = sender["sender_name"]
                                t["sender_classification"] = sender["classification"]
                            report["threat_findings"].extend(threats)

                    elif role == "assistant":
                        # Scan assistant responses for leaked actual secrets
                        threats = check_text_for_threats(full_text, role="assistant")
                        for t in threats:
                            t["line"] = line_num
                            t["timestamp"] = timestamp
                            t["sender"] = "assistant"
                        report["threat_findings"].extend(threats)

    except Exception as e:
        report["error"] = str(e)

    # Convert defaultdicts for JSON serialization
    report["senders"] = dict(report["senders"])
    report["sender_classifications"] = {k: dict(v) for k, v in report["sender_classifications"].items()}
    return report


def generate_summary(reports: list[dict], full_scan: bool) -> str:
    """Generate a human-readable audit summary."""
    lines = []
    now = datetime.now(tz=timezone.utc)
    lines.append(f"# Trust Audit Report")
    lines.append(f"**Generated:** {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"**Mode:** {'Full scan' if full_scan else 'Incremental (since last heartbeat)'}")
    lines.append(f"**Sessions scanned:** {len(reports)}")
    lines.append("")

    # Aggregate stats
    total_messages = sum(r["message_count"] for r in reports)
    total_tool_calls = sum(r["tool_call_count"] for r in reports)
    all_tool_findings = [f for r in reports for f in r["tool_findings"]]
    all_threat_findings = [f for r in reports for f in r["threat_findings"]]
    all_non_trusted = [s for r in reports for s in r["non_trusted_senders"]]

    # Aggregate sender classifications
    class_totals = defaultdict(lambda: defaultdict(int))
    for r in reports:
        for cls, names in r["sender_classifications"].items():
            for name, count in names.items():
                class_totals[cls][name] += count

    lines.append(f"## Overview")
    lines.append(f"- **Total user messages:** {total_messages}")
    lines.append(f"- **Total tool calls (in scanned sessions):** {total_tool_calls}")
    lines.append(f"- **Sensitive tool findings:** {len(all_tool_findings)}")
    lines.append(f"- **Threat/injection findings:** {len(all_threat_findings)}")
    lines.append(f"- **Unknown/untrusted sender interactions:** {len(all_non_trusted)}")
    lines.append("")

    # Sender breakdown by classification
    lines.append(f"## Senders by Trust Level")
    classification_labels = {
        "eddie": "🟢 Owner (Eddie)",
        "trusted_agent": "🟢 Trusted Agent",
        "authorized_human": "🟡 Authorized Human",
        "system": "⚙️ System/Cron",
        "unknown_external": "🔴 Unknown/External",
    }
    for cls in ["eddie", "trusted_agent", "authorized_human", "system", "unknown_external"]:
        if cls in class_totals:
            label = classification_labels.get(cls, cls)
            names = class_totals[cls]
            total = sum(names.values())
            name_list = ", ".join(f"{n} ({c})" for n, c in sorted(names.items(), key=lambda x: -x[1]))
            lines.append(f"- **{label}**: {total} messages — {name_list}")
    lines.append("")

    # Unknown/untrusted interactions (the important ones)
    if all_non_trusted:
        lines.append(f"## 🔴 Unknown/Untrusted Sender Interactions ({len(all_non_trusted)})")
        for s in all_non_trusted:
            lines.append(f"### {s['name']} (ID: {s.get('id', '?')}, Channel: {s.get('channel', '?')})")
            lines.append(f"- **Time:** {s.get('timestamp', '?')}")
            lines.append(f"- **Preview:** `{s['preview'][:150]}`")
            lines.append("")
    else:
        lines.append("## ✅ No Unknown/Untrusted Sender Interactions")
        lines.append("")

    # Threat findings
    if all_threat_findings:
        critical = [f for f in all_threat_findings if f["severity"] == "critical"]
        high = [f for f in all_threat_findings if f["severity"] == "high"]
        lines.append(f"## 🚨 Threat Findings ({len(all_threat_findings)} total: {len(critical)} critical, {len(high)} high)")
        # Group by type for readability
        by_type = defaultdict(list)
        for f_item in all_threat_findings:
            by_type[f_item["type"]].append(f_item)
        for ftype, items in sorted(by_type.items()):
            lines.append(f"### {ftype} ({len(items)})")
            for item in items[:10]:
                icon = "🚨" if item["severity"] == "critical" else "⚠️"
                sender_info = ""
                if item.get("sender"):
                    cls = item.get("sender_classification", "")
                    sender_info = f" | Sender: {item['sender']}"
                    if cls:
                        sender_info += f" [{cls}]"
                lines.append(f"- {icon} {item['detail'][:180]}{sender_info}")
            if len(items) > 10:
                lines.append(f"- ... and {len(items) - 10} more")
            lines.append("")
    else:
        lines.append("## ✅ No Threat/Injection Patterns Detected")
        lines.append("")

    # Sensitive tool usage — summarized, not every single finding
    if all_tool_findings:
        by_severity = defaultdict(list)
        for f_item in all_tool_findings:
            by_severity[f_item["severity"]].append(f_item)

        lines.append(f"## 🔧 Sensitive Tool Usage Summary ({len(all_tool_findings)} findings)")
        for sev in ["high", "medium"]:
            if sev in by_severity:
                by_type = defaultdict(int)
                for f_item in by_severity[sev]:
                    by_type[f_item["type"]] += 1
                type_summary = ", ".join(f"{t}: {c}" for t, c in sorted(by_type.items(), key=lambda x: -x[1]))
                lines.append(f"- **{sev.upper()}** ({len(by_severity[sev])}): {type_summary}")
        lines.append("")
    else:
        lines.append("## ✅ No Sensitive Tool Usage Detected")
        lines.append("")

    # Sessions with errors
    errored = [r for r in reports if "error" in r]
    if errored:
        lines.append(f"## ⚠️ Sessions with Parse Errors ({len(errored)})")
        for r in errored:
            lines.append(f"- `{r['session_id'][:40]}`: {r['error']}")
        lines.append("")

    return "\n".join(lines)


def run_promptguard(reports: list[dict]) -> list[dict]:
    """Run PromptGuard ML model on non-Eddie user messages across all reports.
    Returns list of findings with ML-detected injection attempts."""
    import subprocess

    # Get HF token from 1Password
    try:
        token = subprocess.check_output(
            [os.path.expanduser("~/.openclaw/workspace/scripts/op-get-value.sh"), "HuggingFace"],
            text=True, timeout=15
        ).strip()
    except Exception as e:
        print(f"Warning: Could not get HF token: {e}", file=sys.stderr)
        token = None

    try:
        os.environ["TOKENIZERS_PARALLELISM"] = "false"  # suppress warning
        from transformers import pipeline
        print("Loading PromptGuard model (protectai/deberta-v3-base-prompt-injection-v2)...", file=sys.stderr)
        classifier = pipeline(
            "text-classification",
            model="protectai/deberta-v3-base-prompt-injection-v2",
            token=token,
            device=-1,  # CPU
        )
    except Exception as e:
        print(f"Warning: Could not load PromptGuard model: {e}", file=sys.stderr)
        return []

    # Collect all non-Eddie user message texts with metadata
    candidates = []
    for report in reports:
        try:
            with open(report["file"]) as f:
                for line_num, line in enumerate(f, 1):
                    try:
                        obj = json.loads(line.strip())
                    except json.JSONDecodeError:
                        continue
                    if obj.get("type") != "message" or "message" not in obj:
                        continue
                    msg = obj["message"]
                    if msg.get("role") != "user":
                        continue
                    content = msg.get("content", [])
                    full_text = ""
                    if isinstance(content, str):
                        full_text = content
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                full_text += block.get("text", "") + "\n"
                    if not full_text.strip():
                        continue
                    sender = identify_sender(full_text, agent_name=report.get("agent"))
                    if sender["is_trusted"]:
                        continue
                    # Strip system metadata blocks before ML scoring (reduces FP)
                    import re as _re
                    cleaned = _re.sub(
                        r'(?:Conversation info|Sender|Inbound Context)\s*\(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```',
                        '', full_text, flags=_re.DOTALL
                    )
                    # Strip dot-commands that are legitimate OpenClaw commands
                    cleaned = _re.sub(r'^\.(reset-trust|approve\b|reject\b|status\b)', '', cleaned.strip())
                    cleaned = cleaned.strip()
                    if not cleaned or len(cleaned) < 10:
                        continue
                    # Truncate to 8000 chars for model context window
                    candidates.append({
                        "text": cleaned[:8000],
                        "session_id": report["session_id"],
                        "line": line_num,
                        "timestamp": obj.get("timestamp"),
                        "sender": sender["sender_name"],
                        "classification": sender["classification"],
                    })
        except Exception:
            continue

    if not candidates:
        print("PromptGuard: No non-Eddie messages to scan.", file=sys.stderr)
        return []

    print(f"PromptGuard: Scoring {len(candidates)} non-Eddie messages...", file=sys.stderr)

    # Batch classify (in chunks to manage memory)
    findings = []
    batch_size = 32
    for i in range(0, len(candidates), batch_size):
        batch = candidates[i:i + batch_size]
        texts = [c["text"] for c in batch]
        try:
            results = classifier(texts, truncation=True, max_length=512)
            for c, r in zip(batch, results):
                if r["label"] == "INJECTION" and r["score"] >= 0.90:
                    findings.append({
                        "type": "promptguard_injection",
                        "severity": "critical" if r["score"] >= 0.98 else "high",
                        "detail": f"PromptGuard ML score: {r['score']:.4f} — {c['text'][:150]}",
                        "score": r["score"],
                        "session_id": c["session_id"],
                        "line": c["line"],
                        "timestamp": c["timestamp"],
                        "sender": c["sender"],
                        "sender_classification": c["classification"],
                    })
        except Exception as e:
            print(f"Warning: PromptGuard batch error: {e}", file=sys.stderr)

    print(f"PromptGuard: Found {len(findings)} injection attempts.", file=sys.stderr)
    return findings


def main():
    full_scan = "--full" in sys.argv
    json_output = "--json" in sys.argv
    use_promptguard = "--promptguard" in sys.argv

    # Load heartbeat
    last_audit = None if full_scan else load_heartbeat()

    if last_audit:
        last_dt = datetime.fromtimestamp(last_audit, tz=timezone.utc)
        print(f"Last audit: {last_dt.isoformat()}", file=sys.stderr)
    else:
        print("No previous audit (scanning all sessions)", file=sys.stderr)

    # Find all session files
    session_files = []
    for agent_dir in AGENTS_DIR.iterdir():
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        sessions_dir = agent_dir / "sessions"
        if sessions_dir.exists():
            for sf in sessions_dir.glob("*.jsonl"):
                # Skip if older than heartbeat
                if last_audit and sf.stat().st_mtime < last_audit:
                    continue
                session_files.append(sf)

    print(f"Scanning {len(session_files)} session files...", file=sys.stderr)

    # Audit each session
    reports = []
    for sf in sorted(session_files):
        report = audit_session(sf)
        reports.append(report)

    # Run PromptGuard ML detection if requested
    pg_findings = []
    if use_promptguard:
        pg_findings = run_promptguard(reports)
        # Inject findings back into the first relevant report (or a synthetic one)
        if pg_findings:
            # Group by session and inject
            by_session = defaultdict(list)
            for f in pg_findings:
                by_session[f["session_id"]].append(f)
            for report in reports:
                if report["session_id"] in by_session:
                    report["threat_findings"].extend(by_session[report["session_id"]])

    # Save heartbeat
    save_heartbeat()

    if json_output:
        print(json.dumps(reports, indent=2, default=str))
    else:
        summary = generate_summary(reports, full_scan)
        print(summary)


if __name__ == "__main__":
    main()
