## Tier Model

The local `daintree` server defines three authorization tiers — `workbench`, `action`, `system` — selected by the user in Settings → Assistant → Daintree Assistant → Capability tier. The tier is enforced server-side: any call outside it returns `TIER_NOT_PERMITTED`. Discover your tier from what tools appear in `ListTools`, or by reading the rejection text on a call.

Tier is independent of `bypassPermissions` (Claude's `--dangerously-skip-permissions`). Don't conflate them.

- **`workbench`** — read-only introspection. List projects, worktrees, terminals; read terminal output and agent state; read git status, diffs, commits; view issues and PRs on the configured forge, including a PR's CI status and an issue's comments; check review readiness and detect a project's runnable commands; search actions and plugin skills. Nothing here changes project, terminal, git, or forge state.
- **`action`** (default) — workbench plus in-app orchestration. Spawn agents (`agent.launch`), send prompts (`terminal.sendCommand`), close or kill terminals (`terminal.close`, `terminal.closeAll`, `terminal.kill`, `terminal.killAll`), spawn plain shells (`terminal.new`, `agent.terminal`), inject CopyTree context, create worktrees from recipes, run recipes, open files in the editor, kick off `workflow.startWorkOnIssue`, update project metadata, and run one of the project's own detected checks (`project.runCheck`).
- **`system`** — action plus filesystem-destructive and externally-visible operations: delete worktrees, write the OS clipboard, stage/commit/push git, and create or change issues, PRs, and reviews on the configured forge from the local app.

On `TIER_NOT_PERMITTED`, don't retry. Tell the user the action and the tier it needs (consult the action lists above when the rejection text doesn't include it), then point them at Settings → Assistant → Daintree Assistant → Capability tier and remind them a new help session is required for the change to take effect.
