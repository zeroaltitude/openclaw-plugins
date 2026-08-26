# Vestige Memory System

You have access to Vestige, a cognitive memory system. USE IT AUTOMATICALLY.

---

## 1. SESSION START — Always Do This

1. Search Vestige: "user preferences instructions"
2. Search Vestige: "[current project name] context"
3. Check intentions: Look for triggered reminders

Say "Remembering..." then retrieve context before responding.

---

## 2. AUTOMATIC SAVES — No Permission Needed

### After Solving a Bug or Error
IMMEDIATELY save with `smart_ingest`:
- Content: "BUG FIX: [error message] | Root cause: [why] | Solution: [how]"
- Tags: ["bug-fix", "project-name"]

### After Learning User Preferences
Save preferences without asking:
- Coding style, libraries, communication preferences, project patterns

### After Architectural Decisions
Use `codebase` → `remember_decision`:
- What was decided, why (rationale), alternatives considered, files affected

### After Discovering Code Patterns
Use `codebase` → `remember_pattern`:
- Pattern name, where it's used, how to apply it

---

## 3. TRIGGER WORDS — Auto-Save When User Says:

| User Says | Action |
|-----------|--------|
| "Remember this" | `smart_ingest` immediately |
| "Don't forget" | `smart_ingest` with high priority |
| "I always..." / "I never..." | Save as preference |
| "I prefer..." / "I like..." | Save as preference |
| "This is important" | `smart_ingest` + `promote_memory` |
| "Remind me..." | Create `intention` |
| "Next time..." | Create `intention` with context trigger |

---

## 4. AUTOMATIC CONTEXT DETECTION

- **Working on a codebase**: Search "[repo name] patterns decisions"
- **User mentions a person**: Search "[person name]"
- **Debugging**: Search "[error message keywords]" — check if solved before

---

## 5. MEMORY HYGIENE

**Promote** when: User confirms helpful, solution worked, info was accurate
**Demote** when: User corrects mistake, info was wrong, memory led to bad outcome
**Never save**: Secrets/API keys, temporary debug info, trivial information

---

## 6. PROACTIVE BEHAVIORS

DO automatically:
- Save solutions after fixing problems
- Note user corrections as preferences
- Update project context after major changes
- Create intentions for mentioned deadlines
- Search before answering technical questions

DON'T ask permission to:
- Save bug fixes
- Update preferences
- Create reminders from explicit requests
- Search for context

---

## 7. MEMORY IS RETRIEVAL

Every search strengthens memory (Testing Effect). Search liberally.
When in doubt, search Vestige first. If nothing found, solve the problem, then save the solution.

**Your memory fades like a human's. Use it or lose it.**

---

# Repository CI — what actually runs, and what does not

This monorepo had **no `.github/` directory at all** until `openclaw-vestige-skf`. Every
suite here ran only when a human remembered to run it. Do not tell a reviewer "tests pass"
without saying *where* they passed.

## Covered by CI

| Workflow | Job | Covers | Command |
| --- | --- | --- | --- |
| `.github/workflows/vestige-bridge-tests.yml` | `pytest (bridge)` | `openclaw-vestige/server/tests` | `python -m pytest tests` on Python 3.12 |

Python 3.12 is not arbitrary — `openclaw-vestige/docker/Dockerfile.bridge` is
`FROM ubuntu:24.04` and installs the distro `python3`, so 3.12 is what production runs.

## NOT covered by CI (as of `openclaw-vestige-skf`)

Nothing else in this repo runs anywhere automatically. In particular:

Verified 2026-08-26 by reading every non-`node_modules` `package.json` in the tree:

| Plugin | Has a test command? | In CI? |
| --- | --- | --- |
| `openclaw-provenance` | yes — `npm run validate` = `tsc` + `tsc -p tsconfig.tests.json` + `vitest run` | **no** |
| `openclaw-claude/server` | yes — `npm test` = `vitest run` | **no** |
| `openclaw-beads` | yes — `npm test` = `tsc` + `node --test test/*.test.mjs` | **no** |
| `openclaw-graph-context` | no `test` script | no |
| `openclaw-instrumentation` | no `test` script | no |
| `openclaw-vestige/openclaw-plugin` | no `test` script (the `openclaw-vestige/CLAUDE.md` "Build & Test" line claiming `npm test # jest` here is aspirational, not real) | no |
| `openclaw-cortex`, `openclaw-audit` | no `package.json` at all — loose hooks / a single script | no |

`openclaw-vestige/server/tests` is the **only** Python test directory in the repo.

The **engine** (`vestige-mcp`, Rust) does not live here at all — it is `~/projects/vestige`,
with its own separate CI blind spot (`cargo test --workspace --lib` runs 0 tests for
`vestige-mcp`; see `openclaw-vestige-9ii`).

## Two traps this repo's CI is written to avoid

Read these before adding a workflow here.

1. **`branches:` on `pull_request` matches the *base* ref, not the head.** So
   `pull_request: branches: [main]` means a PR stacked on another feature branch fires
   **no run at all** — and "no run" reads as "nothing to check" rather than "unverified".
   `vestige-bridge-tests.yml` deliberately omits `branches:` from its `pull_request`
   trigger. (This exact trap is live in the engine repo's `ci.yml`, where stacking a PR
   produces zero CI runs.)
2. **A suite that collects 0 tests exits 0 and looks green.** That is how
   `cargo test -p vestige-mcp --lib` hid 379 tests in the engine repo for months.
   `vestige-bridge-tests.yml` therefore asserts a **minimum executed-test count**
   (`MIN_TESTS`) from the JUnit XML and prints the number into the job log. Treat
   `MIN_TESTS` as a ratchet: raise it when tests are added, never lower it to turn a red
   build green. When reviewing a CI run here, read the count — not the checkmark.
