# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Architecture Overview

**This repo does not contain the memory engine.** It is the access layer in front of it.

```
OpenClaw agent
  └─ openclaw-plugin/        TypeScript MCP plugin — declares the vestige_* tools,
     (src/index.ts)          forwards each to an HTTP endpoint on the bridge
        │
        ▼  https://vestige.bighatbio.me/api
     server/                 FastAPI bridge — Bearer auth, agent identity (X-Agent-Id),
     (app/main.py)           REST → MCP JSON-RPC translation. One endpoint per tool.
        │
        ▼  http://localhost:3100/mcp  (Streamable HTTP, protocol 2025-03-26)
     vestige-mcp             THE ENGINE. Rust. Lives in ~/projects/vestige
                             (crates/vestige-core + crates/vestige-mcp).
```

So: a bug in what a `vestige_*` tool *computes* is almost always in `~/projects/vestige`,
not here. A bug in auth, agent identity, argument names, or endpoint shape is here.
See `~/.openclaw-tank/refs/vestige.md` for the engine's build environment and gotchas.

Deployment is a single EC2 host (`vestige.bighatbio.me`) running `vestige-mcp` on :3100,
the bridge on :8000, and Caddy in front — see `docs/EC2-QUICKSTART.md`. **A change to the
engine is not live until that binary is replaced and the process restarted.** The bridge
holds one long-lived MCP session; `GET /api/health`'s `uptime_seconds` is time since that
session was established, which makes it a usable proxy for "how old is the running engine."

## Build & Test

```bash
# TypeScript plugin
cd openclaw-plugin && npm install && npm test        # jest

# FastAPI bridge
cd server && pip install -r requirements-dev.txt && pytest
```

The engine's gates live in `~/projects/vestige` (`cargo test --workspace`, plus
`cargo test -p vestige-mcp --bin vestige-mcp` — see the warning in `refs/vestige.md`
about `--lib` silently running zero tests there).

## Conventions & Patterns

_Add your project-specific conventions here_

## Continuous Integration

`.github/workflows/vestige-bridge-tests.yml` (repo root) runs `server/tests` under pytest
on Python 3.12 — matching `docker/Dockerfile.bridge`, which is `FROM ubuntu:24.04` and
installs the distro `python3`. It fires on every PR regardless of base branch, and on
pushes to `main` that touch `openclaw-vestige/server/**`.

The job asserts a **minimum executed-test count** and prints it to the log, because a
pytest run that collects nothing exits 0 and looks green. When reviewing a run, read the
number. See the root `CLAUDE.md` → *Repository CI* for the full rationale and for what in
this monorepo is still **not** covered.

The TypeScript plugin (`openclaw-plugin/`) is **not** in CI — and as of 2026-08-26 its
`package.json` has no `test` script at all, so there is nothing to run. Neither is the Rust
engine, which lives in `~/projects/vestige` with its own separate blind spot
(`openclaw-vestige-9ii`).
- Beads issues are filed **here** (`openclaw-vestige-*`) even when the fix lands in
  `~/projects/vestige`. Engine commits carry the Beads id in the subject.
- Bridge endpoints must send the argument names the engine's tool schema declares.
  These drift (see `openclaw-vestige-ow6`: `/memory` sent `memory_id`, the tool
  requires `id`, so the endpoint never worked). When adding or editing an endpoint,
  read the corresponding `crates/vestige-mcp/src/tools/*.rs` schema, don't guess.
