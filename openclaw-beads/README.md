# openclaw-beads

OpenClaw plugin that mounts a `/beads` UI on the gateway HTTP server for
visualizing the [Beads](https://github.com/whyleejeremy/beads) issue
tracker as a DAG, with one or more configured repos.

**v0.1 — read-only.** Renders nodes (issues) and edges (dependencies)
via [reaflow](https://reaflow.dev). No mutations yet.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/beads` | UI shell (HTML) |
| GET | `/beads/api/repos` | configured repos |
| GET | `/beads/api/issues?repo=X` | `bd list --json` for repo |
| GET | `/beads/api/deps?repo=X` | dependency edges |

All routes use `auth: "gateway"`.

## Configuration

In `openclaw.json` under `plugins.entries.beads.config`:

```json
{
  "plugins": {
    "entries": {
      "beads": {
        "load": [
          "/path/to/openclaw-plugins/openclaw-beads"
        ],
        "config": {
          "repos": [
            { "name": "openclaw",          "path": "/home/me/projects/openclaw" },
            { "name": "openclaw-vestige",  "path": "/home/me/projects/openclaw-plugins/openclaw-vestige" },
            { "name": "openclaw-provenance","path": "/home/me/projects/openclaw-plugins/openclaw-provenance" }
          ],
          "defaultRepo": "openclaw-vestige"
        }
      }
    }
  }
}
```

The plugin shells out to `bd` from each repo's path. Make sure the `bd`
binary is on the gateway process's `PATH`, or set `bdBinary` to an
absolute path.

## Build

```sh
npm install
npm run build
```

## v0.2+ roadmap

- Multi-repo dropdown UI (already partially wired)
- Filters: status, priority, type, label, full-text search
- Issue detail panel with comments
- Mutations (close / reopen / create / `bd dep add`)
- Vite-built React app to replace the inline esm.sh imports
- Time-travel via `.beads/interactions.jsonl`
