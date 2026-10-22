# Workers

Read when the user names other hosts to run the `/work` agents. It adds to SKILL.md; everything there still applies.

## What changes

- **The workers do the work; this machine orchestrates.** Every `/work` agent runs on a worker, and this machine keeps only the pick, the merge, the checkpoint and the cron. Match the names the user uses to `host.list`'s hosts. Hosts they didn't name are noted in Preflight, never synced or used.
- **Caps.** Each worker has a cap: the user's count for it, else the batch size split evenly. The caps add up to the batch size, which stays the ceiling. Flow's slots are per worker: refill each worker as its slots free, and size each pick per worker.
- **Models.** A model the user sets for a worker goes on every launch there as `"model"`, even when it is that worker's default. With none set, the worker's saved default runs. Choosing a model per issue is `choosing-models.md`, only when the user asks.
- **Instances.** The run's instances are this machine and the workers: Sync brings each up to date before every batch.

## Preflight additions

- On each worker, `host.call` `slashCommands.list` (`agentId: "claude"`) must list `/work`, and `agent.listModels` (`agentId: "claude"`) must list any model the user set for it. Claude's ids are aliases (`sonnet`, `opus`). Otherwise stop before launching anything, and say which.
- `worktree.list` and `terminal.list` there: report any worktree or pane already present, and leave it alone.
- Tell the user, with the rest of step 6: the workers with their caps and models, and that **each worktree delete on a worker is confirmed on this machine, in the window driving that worker, even a hidden one**. They need to keep those windows open, or the deletes time out unseen.

## Calling a worker

Everything a unit needs on a worker goes through `host.call` with that worker's host id and project id, and the same arguments as on this machine: `worktree.createWithRecipe`, `worktree.waitUntilReady`, `agent.launch`, `terminal.getStatus`, `terminal.readLastMessageOwned`, `terminal.getOutput`, `terminal.sendCommand`, `terminal.list`, `terminal.closeMany`, `worktree.deleteOwned` and `project.runCommand`.

```json tool=host.call
{"hostId":"<host id>","projectId":"<its project id>","tool":"agent.launch","args":{"agentId":"claude","model":"<only if set>","worktreeId":"<its worktree id>","name":"Batch <k> · #13401","prompt":"/work 13401","requestedId":"<fresh id, saved first>","notify":true,"replyLines":12,"focusPolicy":"preserve"}}
```

- Read every answer's `outcome`, then `result.isError`, as in Sync. Ids and paths a worker returns mean nothing on this machine: keep each with its host and project id in the unit.
- **One create and one launch per worker at a time**; different workers in parallel. A worker's worktree id is its path, `<its repo's parent>/<repo>-worktrees/<branch with / as ->`. Worktrees made without a recipe are `ready` at once.
- **Check the model once per worker per batch.** After its first launch, `terminal.getOutput` (`maxLines: 200`) on that pane: Claude Code's banner names the model and effort (`Sonnet …`, `Opus … with xhigh effort`). A different model, or a start error naming the id, is reported, and that worker's other launches wait for the user.
- **Notices name the host** ("on host <name>, terminal <id> stopped"). Read the pane with `host.call` `terminal.readLastMessageOwned` there. A notice may never come, so every check reads each worker's live panes with one `terminal.getStatus` there.

## The pick

`<size>` is the free slots across the workers, and the filters say `across <k> instances` and how to split: the user's count per instance (`instance 1 gets up to 8, instance 2 up to 10`), or `choosing-models.md`'s rules. Without counts, `/next-batch` splits evenly, so ask for an uneven split in words. Instance *i* is the *i*-th worker in the order you wrote them. The hand-back adds a line per instance after `BATCH:`:

`… then INSTANCE 1: <its issue numbers, comma-separated, without #> and INSTANCE 2: <its issue numbers>; or BATCH: none if nothing qualifies.`

Check each against the report's `🟩 instance <i> ·` line, and save every unit with its worker.

## Tidy on a worker

- One `project.runCommand` checks all the finished units' worktrees there: a loop printing each path with its `git -C <path> status --porcelain` line count. Judge each line, not the exit code, which a trailing `[ -n … ] && …` makes non-zero.
- `terminal.list` there, once as is and once with `location: "background"`, for panes this run didn't open; then one `terminal.closeMany` there.
- `worktree.deleteOwned` there opens its confirmation on this machine. A hidden window times out with `CONFIRMATION_TIMEOUT`, which declines nothing: stop deleting on that worker, ask the user once to bring its window forward, and delete the rest when they say. Never route around it with `/worker:reset`, the shell or another agent.

## Resume

Reconcile each worker too: `terminal.list` and `worktree.list` there through `host.call`.

## Reports

Each issue with its worker (and model, if set). A worker left out of a sync, or unreachable, with why; its agents keep running while it is disconnected, so read them again once it is back.
