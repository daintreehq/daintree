# Workers

Read when the user names other hosts to run the `/work` agents. It adds to SKILL.md; everything there still applies.

## What changes

- **The workers do the work; this machine orchestrates.** Every `/work` agent runs on a worker, and this machine keeps only the pick, the merge, the checkpoint and the cron. Match the names the user uses to `host.list`'s hosts.
- **Instances.** This replaces SKILL.md's rule that every host holding the repository is an instance (its decisions, Preflight step 4, Sync step 2): the run's instances are this machine and the named workers, and Sync brings each up to date before every batch. Hosts they didn't name are noted in Preflight, never synced or used; a fresh `host.list` refreshes the workers and never adds a host.
- **Caps.** Each worker has a cap: the user's count for it, else the batch size split evenly. The caps add up to the batch size, which stays the ceiling. Flow's slots are per worker: refill each worker as its slots free, and size each pick per worker.
- **Models.** Each launch carries its unit's model and effort wherever it lands (SKILL.md, Models). When the user ties a model to a worker ("Sonnet on X, Opus on Y"), that worker takes only issues it can run: placement follows The pick below.
- **A worker that drops out.** Going on without it in Sync never lets a create or launch reach it before it syncs again: record it as out of sync. Its launched agents keep running and keep their slots; read them again once it is back. Its units not yet launched wait for it, and move to another worker only when the user says so. While it has units waiting, every check runs Sync for that worker alone, against this machine's current `origin/<base>`, and its waiting units are created and launched once it is up to date.

## Preflight additions

- On each worker, `host.call` `slashCommands.list` (`agentId: "claude"`) must list `/work`, and `agent.listModels` (`agentId: "claude"`) must list `sonnet` and `opus`, or the one model tied to it. Claude's ids are aliases (`sonnet`, `opus`). Otherwise stop before launching anything, and say which. Both are answered only while a window drives that project: with none, they answer `NO_FRONTEND_ATTACHED`, which says nothing about the commands or models, and the banner check on the first launch (below) stands in for them.
- `worktree.list` and `terminal.list` there: report any worktree or pane already present, and leave it alone.
- Report, with the rest of step 6: the workers with their caps and models, and that a worktree delete on a worker may open a confirmation on this machine (in the window showing that worker's project when one is open, even a hidden one, and otherwise in the window this assistant runs in) when Daintree is set to ask; an unanswered one is only left pending.

## Calling a worker

Everything a unit needs on a worker goes through `host.call` with that worker's host id and project id, and the same arguments as on this machine: `worktree.createWithRecipe`, `worktree.waitUntilReady`, `agent.launch`, `terminal.getStatus`, `terminal.readLastMessageOwned`, `terminal.getOutput`, `terminal.list`, `terminal.closeMany`, `worktree.deleteOwned` and `project.runCommand`. Input goes through the owned forms there: `terminal.sendCommandOwned`, `terminal.sendKeysOwned` and `terminal.interruptOwned`. A worker refuses the plain `terminal.sendCommand` and `terminal.sendKeys` from another machine's assistant with `TIER_NOT_PERMITTED`.

```json tool=host.call
{"hostId":"<host id>","projectId":"<its project id>","tool":"agent.launch","args":{"agentId":"claude","model":"<the unit's model>","agentLaunchFlags":["--effort","<the unit's effort>"],"worktreeId":"<its worktree id>","name":"Batch <k> · #13401","prompt":"/work 13401","requestedId":"<fresh id, saved first>","notify":true,"replyLines":12,"focusPolicy":"preserve"}}
```

- Read every answer's `outcome`, then `result.isError`, as in Sync. Ids and paths a worker returns mean nothing on this machine: keep each with its host and project id in the unit.
- **One create and one launch per worker at a time**; different workers in parallel. Use the `worktreeId` and `worktreePath` the create returns, never one built from the branch: the path follows that project's own pattern. Setup runs with or without a recipe, so the readiness gate in Start applies there too.
- **Check the model once per worker and model-effort pair per batch.** After the first launch of each pair there, `terminal.getOutput` (`maxLines: 200`) on that pane: Claude Code's banner names the model and effort (`Opus … with xhigh effort`, `Sonnet … with low effort`). A different model or effort, a start error naming the id, or `/work` not starting (an unknown-command line, or no sign its pipeline began), is handled as SKILL.md's Models check does: one relaunch, then run on what the launch gives (or Opus at xhigh) and report it. Nothing waits for the user.
- **Notices name the host** ("on host <name>, terminal <id> stopped"). Read the pane with `host.call` `terminal.readLastMessageOwned` there. A notice may never come, so every check reads each worker's live panes with one `terminal.getStatus` there.

## The pick

Work out Flow's refill count per worker, against its own cap and its own working and queued units. `<size>` is their sum. A worker with nothing to refill gets nothing. `/next-batch` splits only into even counts (`floor(B / K)` each, the first `B mod K` one more), so ask it for one unsplit ranked list of `<size>` and place the issues here, with SKILL.md's pick prompt and no instance count. With an Opus cap or models tied to workers, ask it for no count instead (SKILL.md, Models).

**Placing.** Walk the `🟩 all ·` line in order, which is priority order. Give each issue to the worker with the lowest load among those still under their refill count, where load is the sum of the sizes already given to it (small 1, medium 2, large 3, each issue's `· <size>` in the report). Break ties by fewer issues, then by the order the user named the workers. So every worker opens on top-priority work and large issues spread out, as `/next-batch`'s own split does. With an Opus cap, an Opus issue is placed only while the cap has room. An issue the re-check drops leaves its worker's list. Save every unit with its worker, model and effort.

**Models tied to workers.** Place in two passes over the `🟩 all ·` line, against each worker's refill count:

1. **Opus first.** Walk it for Opus issues only, giving each to an Opus worker with room (lowest load first, as above). Past that, Opus issues are left out: never created, so they come back in a later pick. They never go to a Sonnet worker.
2. **Then Sonnet.** Walk it again for Sonnet issues, giving each to a Sonnet worker with room, then to an Opus worker's leftover room, where it runs on Opus at xhigh. When the user is saving the Sonnet workers' allowance, use the Opus workers' leftover room first. Past that, they are left out.

The first pass keeps the Opus workers for the highest-ranked Opus issues: a Sonnet issue ranked above them never takes their slot.

## Tidy on a worker

- One `project.runCommand` checks all the finished units' worktrees there: a loop printing each path with its `git -C <path> status --porcelain` line count. Judge each line, not the exit code, which a trailing `[ -n … ] && …` makes non-zero.
- `terminal.list` there, once as is and once with `location: "background"`, for panes this run didn't open; then one `terminal.closeMany` there.
- `worktree.deleteOwned` there opens its confirmation on this machine. A hidden window times out with `CONFIRMATION_TIMEOUT`, which declines nothing and names where it asked: stop deleting on that worker for this check, report it once, and retry its pending deletes at the next tidy; never ask. Never route around it with `/reset-worker`, the shell or another agent.

## Allowance, load and restarts

Fetch the runbook named for each from the runbook backend when it first happens (SKILL.md, Runbooks by stage).

- **Allowance is per account.** A working pane's own banner ("You've used 80% of your weekly limit · resets …", in its one-line status) is a reading as of when you saw it: record it with the time and tell the user at once. A threshold the user sets ("stop at 90%") is checked before every launch on that worker once the last reading is 20 minutes old, as `daintree.agents.check-usage-limits` does: a pane launched with no `prompt`, `/usage` at its idle prompt, the panel read, the pane closed. Never `/usage-credits`. At the threshold that worker starts nothing new; its running agents finish. A refused send ("Not sent: this window is switching to …") is no reading: say so, and launch nothing on a guess.
- **A usage limit stops every pane on that account** (`waiting`, `waitingReason: "error"`, "Usage limit reached · limit resets <time>"). Hold launches on that worker until the reset, record the time, and at the first check after it, read every stopped pane: leave the ones working again by themselves, and send each still stopped one continue (`terminal.sendCommandOwned`, `notify: true`), per `daintree.agents.resume-after-usage-limit`. Never relaunch or hand off a limit-stopped unit.
- **Load.** Each check reads `host.list` `load` for the workers. `memoryPressure` `warn` or `critical`: no launches there and a lower cap for that worker; a merge running there counts, with its subagents and test runs (`daintree.hosts.rebalance-load`). Ten heavy `/work` agents plus a merge took one worker to critical and its Daintree restarted.
- **A worker's Daintree restarts** (panes still listed, `terminal.getStatus` says output unavailable, no agent working): every agent there died, but each worktree and conversation survives. Inventory each unit's worktree (`project.runCommand`: ahead, pushed, dirty), then revive each unit once in its own worktree, per `daintree.hosts.recover-and-clean-up`: at Full, `agentSessionHistory.list` there, then `agentSessionHistory.resume` by exact `sessionId`; else `agent.launch` with `agentLaunchFlags: ["--continue", "--fork-session"]` (plain `--continue` fails on the session id Daintree assigns), only where that unit was its worktree's one agent. Check its own task is back on screen, then send `Continue the /work pipeline for #<n> from where you stopped, through to WORK_COMPLETE.` A unit with no work yet relaunches fresh as `/work <n>`. The dead panes, and every earlier pane and worktree there, are no longer this session's (`RESOURCE_NOT_OWNED`): list them in the report to close there, never resume them, or two agents share a worktree. Lower that worker's cap before refilling.

## Resume

Reconcile each worker too: `terminal.list` and `worktree.list` there through `host.call`. Ownership there is this help session's, so a new help session owns nothing on a worker: `terminal.readLastMessageOwned`, `terminal.closeMany` and `worktree.deleteOwned` there answer `RESOURCE_NOT_OWNED` for the earlier panes and worktrees. Read those panes with `terminal.getOutput` where it answers, and list what this session can't close or delete for the user.

## Reports

Each issue with its worker, model and effort. A worker left out of a sync, or unreachable, with why; its agents keep running while it is disconnected, so read them again once it is back.
