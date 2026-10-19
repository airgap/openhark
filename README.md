# openhark

A heterogeneous multi-agent coding swarm. It hands disjoint tickets to a mix of
coding agents (Claude, Gemini/Antigravity, Qwen, and any other CLI you wire in),
each working in its own git worktree and branch. Each opens a pull request, a
**different** agent adversarially reviews it and re-runs the gate, and the
coordinator rebases, re-gates, and merges. Runs are driven from a terminal TUI, a
local web dashboard, or an MCP server.

This is a provider-agnostic extraction of an internal tool. The forge, tracker,
and gate are all pluggable and configured by environment; expect to point them at
your own repo, issue tracker, and test command before the first real run.

## How it works

- **Coordinator** (`bin/coordinator.mjs`) owns everything deterministic: it creates
  a worktree per ticket, runs the agent, gates the result, commits, opens the PR,
  routes it to a reviewer, and serializes merges onto `main`.
- **Agents** only produce work. An author edits code; a reviewer reads the diff and
  posts a verdict as its own forge identity. A PR is never authored and approved by
  the same identity (the forge rejects self-approval). With a single identity, the
  author self-reviews and the coordinator gates the merge on a parsed verdict.
- **Gate** (`bin/gate.sh`) is the merge guarantee, run by the author and again after
  the rebase. What "green" means is your command (`OPENHARK_GATE`).
- **State** (SQLite) is shared between the coordinator (writer) and the dashboard
  (reader); it lives outside any repo.
- **Forge** and **tracker** sit behind small adapters so GitHub, Gitea, Jira,
  Asana, or a custom HTTP source all fit the same shape.

Terminal states include the usual `merged` / `failed` / `changes_requested`, plus
`already_done` (the deliverable already exists) and `disputed` (the ticket's
premise is broken and a human must re-scope it).

## Install

```
npm install          # or bun / pnpm / yarn
```

Node >= 22.5 is required (it uses the built-in `node:sqlite`).

## Configure

Everything is environment-driven. The essentials:

| Variable            | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `OPENHARK_TARGET`   | Path to the repo the agents work in (default: git toplevel of the cwd). |
| `OPENHARK_STATE`    | Where the db/token/logs live (default: `~/.openhark`).                   |
| `OPENHARK_GATE`     | The command that proves a change is safe (tests/typecheck/lint/build).  |
| `OPENHARK_INSTALL`  | Dependency install command for a fresh worktree (default: inferred from the lockfile). |
| `OPENHARK_FORGE`    | `github` (default) or `gitea`.                                          |
| `OPENHARK_TRACKER`  | `github` (default), `jira`, `asana`, or `custom`.                       |
| `OPENHARK_TOKEN` / `DASH_TOKEN` | Break-glass token for the dashboard API (auto-minted if unset). |

The gate fails closed: when `OPENHARK_GATE` is unset or empty, it runs `npm test`
only if the target repo defines a nonempty test script. If neither check exists,
authoring and the final merge re-gate fail and the PR cannot merge. A configured
command takes precedence over `npm test`; its nonzero exit fails the gate without
falling back. Whitespace-only commands are rejected. Configure a real check for
repos without an npm test script; there is no implicit no-op approval.

**Forge (GitHub):** `GITHUB_REPO=owner/repo` (else parsed from the target repo's
origin), and either `GITHUB_TOKEN` or an authenticated `gh` CLI. Real cross-review
needs a **distinct identity per reviewer**: set `GIT_PAT_<AGENT>` per agent (e.g.
`GIT_PAT_CLAUDE`, `GIT_PAT_GEMINI`), because GitHub blocks approving your own PR. A
single token still drives solo self-review and the gated auto-merge.

**Forge (Gitea):** `GITEA_API=https://host/api/v1/repos/OWNER/REPO` (or `GITEA_BASE`
+ `GITEA_REPO`) and `GITEA_TOKEN` (or per-agent `GIT_PAT_<AGENT>`).

**Tracker (GitHub Issues):** open issues are the backlog; a merged ticket's issue
is closed on reconcile. Uses `GITHUB_REPO` + `GITHUB_TOKEN`/`gh`.

**Per-agent tokens file:** `OPENHARK_TOKENS_ENV` (default
`~/.config/openhark/tokens.env`), lines like `export GIT_PAT_CLAUDE=...`.

**Runners:** `SWARM_RUNNERS_JSON` is a JSON array of `{harness, model, cap}` cells;
total parallelism is the sum of caps. Without it, `SWARM_AGENTS` + `--max` split
the roster. Harnesses: `claude` (Claude CLI), `gemini` (Antigravity `agy`), `qwen`
(via an Ollama-compatible endpoint).

**Backlog scope:** `SWARM_PROJECTS` (comma-separated; empty = every project the
tracker exposes) and `SWARM_EXCLUDE_LABELS`.

## Run

```
# 1) start the dashboard/API (mints a token in the state dir)
node bin/dashboard.mjs                 # http://127.0.0.1:5400

# 2) open the terminal UI (auto-connects with the local token)
node bin/tui/index.mjs                 # or: openhark

# 3) or launch a run directly
node bin/coordinator.mjs run tickets.json --go
```

`tickets.json` is a list of `{ "id", "title", "scope", "prompt" }`. `bin/serve.sh`
and `bin/launch.sh` wrap the server and a run as resilient systemd --user units.

The MCP server (`bin/mcp.mjs`) exposes the swarm to an MCP client:

```
{ "openhark": { "type": "stdio", "command": "node", "args": ["bin/mcp.mjs"] } }
```

## Caveats

This is a scrubbed extraction, not a turnkey product. The forge, tracker, and gate
adapters are wired for the common cases above; a different environment (a private
Git host, a bespoke tracker, a multi-account review setup) needs its adapter filled
in. Start with a throwaway repo and `--no-merge` before pointing it at anything you
care about.
