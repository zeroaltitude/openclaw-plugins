# openclaw-audit

A daily security audit tool for [OpenClaw](https://github.com/openclaw/openclaw) agents. Scans session transcripts for sensitive tool usage, untrusted sender activity, prompt injection attempts, and leaked secrets — then produces a structured report.

## What It Does

Every run, `trust-audit.py` reads OpenClaw session JSONL files and reports on:

| Category | What's Checked |
|----------|----------------|
| **Sender Classification** | Classifies every user message sender as owner, trusted agent, authorized human, system, or unknown/external |
| **Sensitive Tool Usage** | Flags exec (especially credential access), gateway config changes, messaging, session spawning, cron management, browser control |
| **Prompt Injection Detection** | Regex heuristics for common injection/jailbreak phrases (e.g. "ignore previous instructions", "bypass security") |
| **ML Injection Detection** | Optional PromptGuard model (`protectai/deberta-v3-base-prompt-injection-v2`) scores non-owner messages for injection probability |
| **Diabolical Content** | Patterns for destructive commands, social engineering, data exfiltration, phishing payloads |
| **Leaked Secrets** | Scans assistant responses for accidentally exposed tokens (Slack, OpenAI, GitHub, AWS, private keys) |
| **Incremental Scanning** | Maintains a heartbeat file so subsequent runs only scan sessions modified since the last audit |

## Requirements

- Python 3.10+
- OpenClaw agent sessions in `~/.openclaw/agents/`
- (Optional) `transformers` + `torch` for PromptGuard ML detection
- (Optional) 1Password CLI (`op`) for HuggingFace token retrieval

## Usage

```bash
# Incremental scan (since last audit)
python3 trust-audit.py

# Full scan (all sessions)
python3 trust-audit.py --full

# With ML prompt injection detection
python3 trust-audit.py --promptguard

# JSON output (for programmatic consumption)
python3 trust-audit.py --json

# Combine flags
python3 trust-audit.py --full --promptguard --json
```

## Configuration

The script uses hardcoded identifier sets at the top of the file. **You must customize these for your setup:**

### Owner Identifiers
```python
EDDIE_IDENTIFIERS = {
    "U010622FNQP",          # Slack user ID
    "159471966640799744",   # Discord user ID
    "eddie",
    ...
}
```
Replace with your owner's identifiers (Slack ID, Discord ID, usernames, etc.).

### Trusted Agents
```python
TRUSTED_AGENTS = {
    "U0ADE5RMUS0": "Tabitha",
    "U0AGLQ6MQRF": "Tank",
    ...
}
```
Replace with your agent bot user IDs and names.

### Authorized Humans
```python
KNOWN_AUTHORIZED_HUMANS = {
    "U06T3449W9H": "Anisha Keshavan",
    ...
}
```
People who are allowed to interact with your agent in shared channels but aren't the owner.

### Sensitive Tools
The `SENSITIVE_TOOLS` dict controls which tool calls get flagged. Adjust severity levels and add/remove tools as needed.

## Setting Up as a Daily Cron Job

The recommended deployment is as an OpenClaw cron job that runs daily and delivers results to the owner privately.

### Example Cron Job (OpenClaw)

```json
{
  "name": "Daily Trust Audit",
  "schedule": {
    "kind": "cron",
    "expr": "15 8 * * *",
    "tz": "America/Phoenix"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Run the daily trust audit: python3 ~/.openclaw/workspace/scripts/trust-audit.py --promptguard. Read the output, format it as a clear security report, and send it to me. Flag anything critical prominently."
  },
  "sessionTarget": "isolated",
  "delivery": {
    "mode": "announce"
  }
}
```

**Key points:**
- Use `sessionTarget: "isolated"` so the audit runs in its own session (no context leakage)
- Use `delivery.mode: "announce"` to deliver results to the owner's private channel
- The `--promptguard` flag enables ML detection (first run downloads the model ~500MB)
- Schedule during a time the owner will see it (e.g. morning)

## PromptGuard ML Detection

When `--promptguard` is passed, the script:

1. Collects all non-owner user messages from scanned sessions
2. Strips metadata blocks and system commands to reduce false positives
3. Runs each through `protectai/deberta-v3-base-prompt-injection-v2` (DeBERTa classifier)
4. Flags messages scoring ≥0.90 as injection attempts (≥0.98 = critical, else high)

The model auto-downloads on first use via HuggingFace `transformers`. If a HuggingFace token is needed (for gated models), the script attempts to retrieve it from 1Password — customize the retrieval method for your setup.

## Output Format

### Text (default)
A markdown-formatted report with sections:
- **Overview** — message counts, finding totals
- **Senders by Trust Level** — who interacted with the agent, classified
- **Unknown/Untrusted Sender Interactions** — details on unrecognized senders
- **Threat Findings** — injection patterns, diabolical content, leaked secrets
- **Sensitive Tool Usage Summary** — aggregated by severity and type

### JSON (`--json`)
Array of per-session report objects, each containing:
- `senders`, `sender_classifications` — who sent messages
- `tool_findings` — sensitive tool usage with severity, type, detail
- `threat_findings` — injection/threat detections with severity and context
- `non_trusted_senders` — unknown sender details with message previews

## Heartbeat / Incremental Scanning

The script maintains a heartbeat file at `~/.openclaw/agents/.trust-audit-heartbeat`. Each run:
1. Reads the last audit timestamp
2. Only scans session files modified after that timestamp
3. Saves the current timestamp after completion

Use `--full` to ignore the heartbeat and scan everything.

## License

Same as [openclaw-plugins](../LICENSE).
