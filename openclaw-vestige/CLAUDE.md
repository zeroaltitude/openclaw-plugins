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


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

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
