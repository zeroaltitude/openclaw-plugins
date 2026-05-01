# openclaw-beads

OpenClaw plugin that mounts a `/beads` UI on the gateway HTTP server for
visualizing and managing Beads issue tracker repos as dependency DAGs.

It also implements an **ambient run loop**: before agent prompts are sent to
the LLM, the plugin can inject a `<plans_and_tasks>` block listing ready Beads
work assigned to the current agent (or `any`) and the run-loop discipline for
keeping issue state truthful.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/beads` | UI shell (HTML) |
| GET | `/beads/<repo>` | UI shell with URL-backed repo selection |
| GET | `/beads/api/repos` | configured repos + owner enum |
| GET | `/beads/api/issues?repo=X` | issues for repo; prefers `.beads/issues.jsonl` fast path |
| GET | `/beads/api/deps?repo=X` | dependency edges; prefers exported dependency arrays |
| GET | `/beads/api/issue/:id?repo=X` | issue detail |
| PATCH | `/beads/api/issue/:id?repo=X` | update title/status/type/priority/owner/refs/target_datetime |
| DELETE | `/beads/api/issue/:id?repo=X` | delete issue (`bd delete --force`) |
| POST | `/beads/api/issue/:id/close?repo=X` | close issue |
| POST | `/beads/api/issue/:id/reopen?repo=X` | reopen issue |
| POST | `/beads/api/issues/create?repo=X` | create issue |
| POST/DELETE | `/beads/api/deps/edit?repo=X` | add/remove dependency edge |

Routes use `auth: "plugin"`. The intended deployment is a loopback-bound gateway
(`127.0.0.1` / `::1`) so the browser can use the UI without a gateway token while
external exposure remains owned by the gateway bind policy.

## UI semantics

- Cards are status-colored and show owner.
- Closed issues are hidden by default; use **show closed** in the top bar.
- Dependency edge `A → B` means: `A` depends on `B`; `B` blocks `A`.
- Add edges by selecting a node and dragging its blue anchor to another node.
- Remove edges from the detail panel or by clicking the edge.
- Owners are selected from an enum: configured local agents plus `eddie` and `any`.
- Supported statuses include: `open`, `in_progress`, `waiting_for_user`,
  `waiting_for_available_agent`, `blocked`, `closed`, `deferred`.
- `target_datetime` is stored both as native Beads `due_at` and as
  `metadata.target_datetime` for run-loop semantics.

## Run loop

When enabled, the plugin registers:

- `before_prompt_build` typed hook: injects a `<plans_and_tasks>` block.
- `gateway:startup` internal hook: requests a heartbeat wake after gateway startup
  so ready Beads work can be assessed through the normal agent loop.

### Ready-work selection

For each configured repo, the run loop:

1. Skips repos whose configured name matches `/test/i`.
2. Runs `bd ready --json`.
3. Filters ready issues to owner/assignee equal to the current agent id or `any`.
4. Injects up to `runLoop.readyLimitPerRepo` issues per repo.

### Injected discipline

The prompt block tells the agent:

- First satisfy the user’s current request.
- Treat ready Beads issues as background work opportunities.
- For non-trivial work, ensure a Beads issue exists.
- Simple exchanges do not need issues.
- Default new issue assignee is the current agent id, unless the user specified
  another owner or the work belongs in general backlog (`any`).
- Mark started work `in_progress`.
- Close completed work.
- Use `waiting_for_user`, `waiting_for_available_agent`, or `blocked` truthfully.
- Create/update issues for durable future work, bugs, investigations, reminders,
  and other trackables; include `target_datetime` when timing is implied.

## Configuration

In `openclaw.json` under `plugins.entries.beads.config`:

```json
{
  "repos": [
    { "name": "openclaw", "path": "/home/me/projects/openclaw" },
    { "name": "openclaw-beads", "path": "/home/me/projects/openclaw-plugins/openclaw-beads" },
    { "name": "bd-test", "path": "/tmp/bd-test" }
  ],
  "defaultRepo": "openclaw-beads",
  "ownerOptions": ["any", "eddie", "tank"],
  "runLoop": {
    "enabled": true,
    "readyLimitPerRepo": 1,
    "includeUnassigned": false,
    "startupWake": true,
    "startupWakeTarget": "last",
    "startupWakeDelayMs": 1000
  }
}
```

The plugin shells out to `bd` from each repo path for mutations and ready-work
queries. For list/dependency reads, it prefers `.beads/issues.jsonl` when present
for speed. Set `bdBinary` if the gateway process needs an absolute path.

## Build/test

```sh
npm install
npm run build
npm test
```

## Notes

- Avoid `bd edit` from web/API flows because it invokes `$EDITOR`.
- Use non-interactive commands (`bd create`, `bd update`, `bd close`,
  `bd reopen`, `bd delete --force`, `bd dep add/remove`).
- The run loop is prompt-guidance plus ready-work surfacing; issue mutations still
  happen through the agent’s normal tool/command actions after it decides what to do.
