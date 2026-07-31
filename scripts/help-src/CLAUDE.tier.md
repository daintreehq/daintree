## Tier Model

The local `daintree` server defines three authorization tiers — `workbench`, `action`, `system` — selected by the user in Settings → Assistant → Daintree Assistant → Capability tier. The tier is enforced server-side: any call outside it returns `TIER_NOT_PERMITTED`. Don't read your tier off `ListTools` — it advertises only a small core, so most of what your tier permits never appears there. `actions.search` is the better signal: it returns only what your session can actually dispatch, so a tool it can't find is one your tier doesn't reach.

Tier is independent of `bypassPermissions` (Claude's `--dangerously-skip-permissions`). Don't conflate them.

- **`workbench`** — read-only introspection. List projects, worktrees, terminals; read terminal output and agent state; read git status, diffs, commits; view GitHub issues and PRs. No mutations.
- **`action`** (default) — workbench plus full in-app orchestration. Spawn agents (`agent.launch`), send prompts (`terminal.sendCommand`), close or kill terminals (`terminal.close`, `terminal.closeAll`, `terminal.kill`, `terminal.killAll`), spawn plain shells (`terminal.new`, `agent.terminal`), inject CopyTree context, create worktrees from recipes, run recipes, open files in the editor, kick off `workflow.startWorkOnIssue`, update project metadata.
- **`system`** — action plus filesystem-destructive and externally-visible operations: delete worktrees, write the OS clipboard, stage/commit/push git, open issues/PRs on GitHub from the local app.

On `TIER_NOT_PERMITTED`, don't retry. Tell the user the action and the tier it needs (consult the action lists above when the rejection text doesn't include it), then point them at Settings → Assistant → Daintree Assistant → Capability tier and remind them a new help session is required for the change to take effect.
