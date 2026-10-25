---
name: work-batch
description: "Work this repository's issue backlog in batches. A Claude Code agent in the main worktree picks the batch with /next-batch, this machine and every host it reaches over SSH that holds the repository are brought up to date with origin's base branch, each issue gets its own worktree and a Claude Code agent running /work on the model /next-batch gave it (Sonnet unless the issue needs Opus), here or on worker hosts the user names, and a Claude Code agent in the main worktree runs /merge-prs whenever finished PRs are waiting (green, or red CI that /work gave up on). It runs as a flow: slots are refilled as agents finish and merges happen while others work, so nothing sits idle. Checks in every 10 minutes. One batch by default; with 'drain' it keeps refilling, working and merging until /next-batch finds nothing ready and everything has landed. Use when the user asks to run, work or drain the next batch of issues, not to only list what the next batch would be."
argument-hint: "[batch size, default 8] [drain] [worker hosts] [filters for /next-batch, e.g. only bugs]"
---

# Work batch

A run is a flow, not a sequence of rounds (see Flow). There are as many `/work` slots as the batch size, and you keep them full: whenever slots free up, pick more issues, bring every instance up to date with origin, and give each its own worktree and `/work` agent. Each agent's PR is checked for green CI as it finishes and its worktree is cleared then and there; `/merge-prs` runs whenever finished PRs are waiting and none is running, alongside the agents still working. A batch is just one pick's issues, which names their panes. You coordinate and verify; you never pick issues, implement, review or merge yourself. Every pane you start is a **Claude Code terminal** (`agentId: "claude"`), whatever agent you run on and whatever the user's default agent is: `/next-batch` and `/merge-prs` in the main worktree on this machine, `/work` in each issue's own worktree. Every `/work` launch carries its issue's model (see Models). The pick and the merge launch with no `model` and no `presetId`, so they run the user's saved Claude defaults like the user's own panes. No launch ever takes a `presetId`.

Arguments: `$ARGUMENTS`

- A number is the batch size, default **8**: the number of `/work` slots, and the concurrency ceiling. Never more than that many `/work` agents at once, never two picks or two `/merge-prs` panes at once, and never a second run for this repository while one is active.
- `drain` (or "until drained", "keep going") keeps refilling slots until a pick comes back empty and everything has landed. Without it, the run is one batch: one pick, its agents, and the merges that land them, and Flow never starts another pick. A drain has no fixed end: issues filed while it runs are picked too.
- `resume` continues a run from its checkpoint (see Resume). `status` only reports and changes nothing.
- Hosts named to do the work are covered by `workers.md`. Requests about models ("all on Opus", "at most 4 Opus") are covered by Models.
- Anything else goes to `/next-batch` as its filters, unchanged.

## Optional parts

These files sit beside this one. Read one only when it applies; otherwise ignore it.

- **`workers.md`**: the user names other hosts to run the `/work` agents ("put 8 on X and 10 on Y"), with or without caps or models. Read it before Preflight; it adds to Preflight, the pick, Start, the checks and Tidy.
- **`estimating.md`**: the user asks how long the run or the drain will take.

Note in the checkpoint which ones apply, so a resumed run reads them again.

## Runbooks and the user's decisions

The runbook that owns this work is `daintree.orchestration.work-in-waves` (merge-gated rounds, drains included; this skill runs them as a flow), with `daintree.foundation` for the mechanics (dialogs, ownership, delivery, proving a finish). With worker hosts (`workers.md`), the owner is `daintree.hosts.drain-issue-backlog` instead. Make this request's one runbook search with `"Work batches of issues in parallel worktrees, merge their pull requests, then start the next batch"`, or with worker hosts `"Drain an issue backlog across several remote hosts, picking and merging on this machine"`, exactly as written, and follow what it selects, as the runbook rule says. If the owner isn't among them, take the flow from this skill and the mechanics from the foundation that came back, and never claim a runbook you didn't load.

**Runbooks by stage.** You can't open a runbook file: every runbook comes from the runbook backend, `get_runbook` with its id when you know it (the ids below), else `search_runbooks` with a sentence describing the situation. Fetch one when its stage first arrives, not up front; one delivery per session is enough, since its text stays in your context (re-fetch after a compaction). When the user asks you to load or follow a runbook, fetch it the same way and say which one came back.

- Syncing instances before a create: `daintree.hosts.sync-with-origin`.
- The first pick's models (see Models): `daintree.agents.choose-agent-model`.
- Reading a host's or account's allowance, or a usage threshold the user set: `daintree.agents.check-usage-limits` (a pane launched with no `prompt`, then the usage command at its idle prompt).
- Agents stopped on a usage limit that names its reset: `daintree.agents.resume-after-usage-limit`.
- A worker under memory pressure, or one to take fewer agents: `daintree.hosts.rebalance-load`.
- A worker's Daintree restarted and its agents died: `daintree.hosts.recover-and-clean-up`.
- A pane that is hung, failed to start or lost its notice: `daintree.agents.recover-agent`; one asking a question the user must answer: `daintree.agents.answer-waiting-agent`.
- The user pausing, resuming or handing the run to another session: `daintree.orchestration.status-and-resume` (with workers, `daintree.hosts.park-swarm`).

The user wrote this skill, and it records their decisions where those runbooks leave room or assume otherwise:

- **The batch and its overlap policy are `/next-batch`'s.** It allows ordinary overlap and leaves it to `/merge-prs`, excluding only structural clashes: the user's policy, looser than a disjointness gate. Report its verdict as the gate's result; don't re-split, serialize or drop issues. The one exception is placement: `/next-batch` splits only into even counts, so with uneven worker caps, models tied to workers or an Opus cap, it returns one ranked list and this skill places each issue (`workers.md`, Models).
- **The cap is the batch size**, already approved.
- **Nothing sits idle** (see Flow). A pick takes about 15 minutes and a merge an hour, so neither waits for the other, nor for a batch's last few agents: slots are refilled as they free, and merges run while agents work.
- **CI is read before a PR is counted finished.** As each unit finishes, its PR's checks are read, and an agent whose PR is red is told to fix it, at most once and never after `/work` has ended its own fix loop. Red CI left for the merge finishes the unit, and its PR waits for a merge like a green one (see step 3).
- **Every instance starts a batch on origin's base.** This machine and every host it reaches over SSH that holds this repository fetch origin and fast-forward to `origin/<base>` before each batch creates anything, whatever runbook drives the work (see Sync). Fast-forwards only: an instance is never switched, stashed, reset, cleaned or force-updated, and one that can't fast-forward holds new creates until the user fixes it or says to go on without it.
- **Each unit's whole chain is one command, `/work <n>`**, sent unchanged with no brief.
- **Every `/work` agent runs on the model `/next-batch` gave its issue**, Sonnet or Opus, as a launch `model`, even where it matches the default. Sonnet is the default and Opus needs a named trigger in the pick (see Models). That is the user's policy: save allowance on Sonnet, never skimp where Opus helps. Never re-tier an issue yourself, and never move an Opus issue to Sonnet to save allowance or fill a slot.
- **No `handback` on `/work` or `/merge-prs`**, for `daintree.agents.run-agent-command`'s reason: Daintree appends its instruction to the prompt text, which would become the command's arguments. Both print their own end markers, read exactly with `terminal.readLastMessageOwned`. The pick is a sentence, so it takes `handback`.
- **`/merge-prs` lands every eligible open PR in the repository**, not only this batch's.
- **Teardown is total, per unit, and doesn't wait for the merge**: as each unit finishes (green CI, no-op, failed or skipped), its pane is closed and its worktree closed out through the Daintree MCP (`worktree.deleteOwned`), landed or not, so the worktree sidebar never fills with finished work. The branch is on origin, so the merge never needs the worktree. Branches and PRs stay, so nothing committed is lost. Any worktree left on disk is reported with its reason.
- **A recurring cron replaces the per-turn `ScheduleWakeup` backstop.** A wakeup loop isn't restored on `claude --resume` (that stalled a `/work` wave for an hour on 2026-10-14) and ends at a maximum duration. The cron is still the one pacing mechanism.

## Models

Every `/work` unit runs on a model, and `/next-batch` chooses it: each issue in its report ends `· <size> · <model>`, `sonnet` or `opus`, and every `opus` names its trigger (an unknown root cause, concurrency or lifecycle, an open design or contract decision, data, auth or security, new cross-process behaviour, measured performance work, a failed earlier attempt). Everything else is Sonnet, which matches Opus on well-scoped work at half the cost. The aim is as much on Sonnet as the work allows, and Opus wherever its trigger is real.

- **Read it from the report.** Each issue's model is the one on its report line; the `🟩 opus ·` and `🟩 sonnet ·` lines are the cross-check, and together hold the `🟩 all ·` line's issues. An issue with no model, or two, is an invalid pick (Pick, step 2). Still missing after the correction: run it on Opus and tell the user.
- **Launch with it.** `"model": "sonnet"` or `"opus"`, the aliases `agent.listModels` lists for `claude`, on every `/work` launch and on any relaunch of that unit. Save it in the unit before the launch.
- **Check it once per model per batch.** After the first launch of each model in a batch, `terminal.getOutput` (`maxLines: 200`) on that pane: Claude Code's banner names the model and effort (`Sonnet …`, `Opus … with xhigh effort`). A different model, or a start error naming the id, is reported, and that model's other launches wait for the user. Effort stays the user's saved default.
- **Slots are shared.** Both models draw on the same slots and the same account allowance, so the batch size stays the one ceiling, and placement follows pick order whatever the model.
- **The user's overrides** apply from the next pick, recorded with the time; units already launched keep theirs. "All on Opus" or "all on Sonnet" replaces the report's model for every unit; Sonnet-only also leaves Opus issues out (below) unless the user says to run them on Sonnet. "At most N on Opus" caps the Opus units working or queued at once. "Opus for #n" or "Sonnet for #n" sets one issue.
- **Opus issues beyond a cap wait.** They are left out of the batch, never created, so they stay unassigned and come back in a later pick; they never drop to Sonnet. With a cap, ask the pick for no count (the pick prompt's first sentence becomes `Run /next-batch.`, with any filters): it reads every candidate's thread whatever the count, and the rule that a pick may not exceed `<size>` doesn't apply. Then walk the `🟩 all ·` line in order, taking each issue while the refill count has room, and an Opus one only while the cap does too, until the refill count is met. The rest are left out. Expect it to bite: on 2026-10-22, 36 of a ready frontier came out heavy.
- **Report it.** Each unit's line names its model, and the final report gives the batch's split (`5 Sonnet, 3 Opus`).

## Preflight, once per run

1. `worktree.list`: the main worktree is the row with `isMain: true`. Run `gh repo view --json nameWithOwner,defaultBranchRef` in its path for the repo and the base branch. Every later `gh` call takes `--repo <owner>/<repo>` and every `git` call `-C <path>`, because your own working directory is not the repository. A failed forge read is unknown, never an empty result.
2. `slashCommands.list` with `agentId: "claude"` and the main path as `projectPath`: `/next-batch`, `/work` and `/merge-prs` must each be listed once. All three are skills now (`~/.claude/skills/`), and the list includes skills. `agent.listModels` with `agentId: "claude"` must list `sonnet` and `opus`. Otherwise stop before launching anything, and say which; a `/prs:merge` listed instead of `/merge-prs` means that machine still has the old commands.
3. A checkpoint for this repository that is neither `done` nor `cancelled` is an active run: resume it instead.
4. **Find the instances.** This machine is one. `host.list` (it dials an idle controlled host first); for each host `connected` with `control: true`, find this repository among its `projects` with `host.call` `project.runCommand` and `git remote get-url origin`, the projects whose name matches the repository's first, stopping at the first URL that names `<owner>/<repo>` (https or ssh, `.git` or not). That host and project are an instance. A project answers only with outcome `ok`, `result.isError: false` and `result.structured.exitCode` 0; a non-zero exit means it isn't this repository. A host with no match, but `projects: null` or a call that didn't answer, is unresolved: it is held as Sync holds an instance. A tier refusal (`TIER_NOT_PERMITTED`) comes only from a host on an older build, where `project.runCommand` answered the **full** tier alone: that host can't be synced, so ask the user to update it or raise the assistant's tier, or to go on without it. Any other host is noted for the user. No `host.list` tool, or no hosts: this machine is the only instance.
5. If the main checkout isn't clean and on the base, say so now: the merge step waits for it, and Sync holds one with uncommitted changes on the base.
6. Tell the user in a few lines: batch size, one batch or drain, any filters, that each `/work` agent runs on the model the pick gives its issue (and any model override or Opus cap), which hosts are brought up to date with origin before each batch and which can't be reached, that `/merge-prs` runs whenever finished PRs are waiting and lands every eligible PR, that every worktree the run creates is deleted as soon as its unit finishes (each delete may ask them to confirm), and that a question from any pane parks that pane until they answer it, while the rest of the run goes on.
7. Archive a finished checkpoint (`done` or `cancelled`) to `<owner>-<repo>.<its run id>.json`, write the new one, then create the cron.

## Pacing

`CronList` first, so a lost earlier reply never leaves two. Then one `CronCreate`: cron `3,13,23,33,43,53 * * * *`, recurring, prompt `Work-batch check for run <run id>: continue it from its checkpoint unless it is cancelled or done. After a compaction, or if the work-batch skill is not in your context, read .claude/skills/work-batch/SKILL.md first.` Record its id and creation time; it expires after 7 days, so recreate it after 6. `CronDelete` it when the run ends or is cancelled. Fires run only while you are idle and can come a few minutes late. A fire or a notice (`notify: true` on every launch and send) only asks for a check: several queued together make one check, classified from a fresh status, never from the notice text. If `CronCreate` is unavailable, end every turn with `ScheduleWakeup` `{delaySeconds: 600, reason, prompt, noop}`; if it answers "Wakeup not scheduled", tell the user monitoring has stopped.

Every read stays in your context for hours, so keep checks lean: one `terminal.getStatus` over the live panes with `includeOutput: {"lines": 1}` (which returns `lastOutputChangeAt`), and more only for a pane that stopped or went quiet. A check that changes nothing ends with one short line.

## Run state

Checkpoint: `~/.daintree/work-batch/<owner>-<repo>.json`, outside the repository and kept across restarts, written atomically (temp file, then `mv`). Record intent before acting (the branch before a create, the `requestedId` before a launch, `nudged` before a nudge), so a lost reply is reconciled, never replayed. It holds the run (id, repo, base, main worktree id and path, size, drain, filters, the optional parts in use, the user's mid-run decisions with times, `stopAfterRound`, `cancelled`, cron id and creation time, the latest batch number, phase `running`, `stopping` (admitting nothing new, see step 6) or `done`), the instances (host id and name, project id, the SHA each last synced to, why one is held or left out), each batch's target SHA and whether its sync is held, the pick and merge panes (at most one of each), the unit PRs open when the running merge started, each unit (issue, batch, model and its trigger, branch, worktree id and path, `requestedId`, terminal id, status, PR, CI state, the PR's outcome: merged, closed, deferred, reverted or left for the user, `lastOutputChangeAt` and when it was counted, quiet checks, `nudged`, a reported question's id, worktree delete outcome), and one line per finished batch and per finished merge. A unit stays until it is tidied and its PR has merged or closed, or a completed merge has deferred or reverted it. Live state outranks it. Panes are named `Batch <k> · next-batch`, `Batch <k> · #<n>` and `Batch <k> · merge`.

Unit statuses: `setting-up`, `queued` (ready, waiting for a slot), `dispatching`, `running`, `done` (finished with a PR), `no-op` (finished, nothing to change), `failed`, `blocked` (waiting on the user), `skipped`. A unit holds a slot from its launch until it is finished: `done` with its PR's checks green, the PR merged or closed, the PR handed to a running merge, or its red CI left for the merge (step 3), or `no-op`, `failed`, or `skipped` and no longer working. A finished unit is tidied at once (step 5).

## Every launch

```json tool=agent.launch
{"agentId":"claude","model":"<the unit's model>","worktreeId":"<worktree id>","name":"Batch <k> · #13401","prompt":"/work 13401","requestedId":"<fresh id, saved first>","notify":true,"replyLines":12,"focusPolicy":"preserve"}
```

The pick and merge launches leave out `model`. Claude launches go one at a time per machine. A good result has `launched: true` and the requested `worktreeId`. On a lost or ambiguous reply, `terminal.list` with `terminalId` set to the saved `requestedId` (it becomes the pane's `id`) and check its `title`, `agentId` and `worktreeId`; never launch on top of it. `launched: false` with a null `spawnStatus` is an unspecified failure (one cause: the hard open-panel ceiling): close this run's panes that tidy would close anyway and retry once. Still failing: fail that unit; for the pick or the merge pane stop early as in step 6, telling the user either way.

## Every check

Read the checkpoint first: `cancelled` or `done` means do nothing more (delete the cron if it still exists). Otherwise take a fresh `terminal.getStatus`, and for each live pane, a held sync or not:

1. **Working**: a quiet check counts only when `lastOutputChangeAt` hasn't moved and 9 minutes have passed since the last counted one. At two in a row, take a 30-line screen read: a dialog is handled as in 2; otherwise tell the user once it may be stuck, and keep waiting. A `/work` agent with its PR up is usually watching CI, and is often silent for ten minutes at a time: that is not stuck. Never interrupt or close a working pane. (The merge pane has its own rule, in step 4.)
2. **Stopped** (not working, or exited): `terminal.readLastMessageOwned`, then classify by the pane's end marker (the pick's, `/work`'s or the merge's).
   - A question in `unansweredToolUses`, or a dialog other than a trust prompt for the pane's own folder (answer that per the help rules), makes it `blocked`. Report it once, quoted with its options, and record that; never nudge, fail or close a blocked pane. Send the user's answer only to a visible single-choice menu (`terminal.sendKeys` `choose`, `notify: true`); otherwise `terminal.revealOwned` the pane so they answer there.
   - `newerRecordsFollow: true` means something came after that text, not that it's working: take a 30-line screen read before deciding.
   - An exited process fails it. An unavailable read: decide from a 50-line screen read.
3. **Paused, not stopped.** A last reply whose final non-empty line starts with `WORK_WAITING` (a `/work` pane) or `MERGE_WAITING` (the merge pane), usually followed by what it waits on, is the skill waiting on background work it started (a Codex call, a subagent, a CI watch), which wakes it. Treat that pane as working, under step 1's quiet-check rule; never nudge it.
4. **Stopped without its marker, a pause or a question** (not the merge pane): one 30-line screen read. A usage or rate limit naming a reset time: record it and wait. Otherwise, or once reset, set `nudged` and nudge once with `terminal.sendCommand` (`notify: true`) and the pane's nudge text. Stopping again without its marker after that fails it.

Never resend a launch prompt. A pane showing no sign that its command started is `blocked`: ask the user. Every check ends by running a held Sync again, then applying Flow: it may launch into a freed slot, start a pick, or start a merge.

## Sync

Each batch brings every instance up to date with origin before step 2 creates any of its worktrees. Merges since the last sync, the user's and other sessions' included, move `origin/<base>`, and neither a forge merge nor worktree creation updates any checkout.

The sync command, with `<base>` filled in, fetches the base and then fast-forwards: the checkout itself only when it is on the base with no uncommitted changes to tracked files, and otherwise only its local `<base>` branch, which git refuses while another worktree has it checked out.

```bash
git fetch --quiet origin "+refs/heads/<base>:refs/remotes/origin/<base>" || exit $?; if [ "$(git branch --show-current)" != "<base>" ]; then git fetch --quiet origin "<base>:<base>"; elif [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "uncommitted changes on <base>"; false; else git merge --ff-only --quiet "origin/<base>"; fi; s=$?; git branch --show-current; git rev-parse "refs/heads/<base>" "refs/remotes/origin/<base>"; exit $s
```

1. **This machine.** Run it as `(cd "<main path>" && <command>)`, the one git call here without `-C`. While a merge is running, run only the command's first `git fetch` instead: the merge owns the main checkout and fast-forwards it itself, and two writers there collide on its index, while the worktrees branch from `origin/<base>` either way. Then save `git -C <main path> rev-parse origin/<base>` to the checkpoint as the batch's target.
2. **The hosts.** A fresh `host.list`, adding any instance new since Preflight as found there, then one call per instance. It runs in the project's root as the host's user, and `timeoutMs` keeps the relay waiting as long as the command may run (without it the relay gives up after 90 seconds):

```json tool=host.call
{"hostId":"<host id>","projectId":"<its project id>","tool":"project.runCommand","args":{"projectId":"<its project id>","command":"<the sync command>","timeoutMs":300000}}
```

3. **Read each answer** from `result.structured`: `exitCode`, `timedOut`, and the `output`, whose last two lines are the SHAs. Up to date is exit 0 with both at the target (for this machine's fetch alone, `origin/<base>` at the target). When one differs, fetch here again: if this machine's `origin/<base>` moved, that is the new target, so sync every instance again, once; any mismatch left is held.
   - `ambiguous`: resend under its `callId`. `expired`: its record is gone, so run it again as a new call; the sync is safe to repeat. `rate_limited`: retry after `retryAfterMs`. `not_found`: list again; a host or project still missing isn't an instance any more, and is reported.
   - `disconnected`, `opted_out` or `unsupported`: the host can't be reached for this batch. Report it and go on without it.
   - Anything else is **held**: a non-zero exit or a timeout, a result with `isError` (`DRIVEN_ELSEWHERE` names the machine driving that project: never take it over), or another outcome, with its `detail`. Report it once with the last lines of its output. Never switch, stash, reset, clean or force-update to make it pass.
4. Step 2 creates none of the batch's worktrees while an instance is held, unless the user has said to go on without that host. Record each instance's SHA or reason in the checkpoint. A held sync holds only that batch: every check still reads the live panes, then runs Sync again from step 1, so the user's fix is picked up and every instance meets the same target.

## 1. Pick

```json tool=agent.launch
{"agentId":"claude","worktreeId":"<main worktree id>","name":"Batch <k> · next-batch","prompt":"Run /next-batch with a count of <size>. Pass it no other arguments. This is a planning run: assign, comment on and change nothing. When the report is done, your hand-back summary is the batch in exactly this form: BATCH: 13401, 13388, 13390 (the issue numbers from the report's closing 'all' line, in that order, without #), or BATCH: none if nothing qualifies.","requestedId":"<fresh id, saved first>","notify":true,"handback":true,"focusPolicy":"preserve"}
```

`<size>` is the slots free or about to be (see Flow): the batch size for the first pick. With filters, the first sentence becomes `Run /next-batch with a count of <size> and these filters: <filters>.` A pick takes 5 to 20 minutes, and can run while a merge does: it only reads. Its marker is the hand-back line. Nudge text: `Finish the /next-batch report and hand back the BATCH line.`

1. **Read the batch.** It is the report's `🟩 all ·` line, and each issue's model is on its report line (see Models). Page a truncated reply with `message.nextCursor`, and earlier replies with `messageIndex` (never together with `cursor`). The `BATCH:` line is a cross-check: if it differs, use the `🟩` line and tell the user.
2. **Handle an invalid pick.** No `🟩 all ·` line, an issue without exactly one model, duplicates, or more issues than `<size>` (when a count was given) gets one correction request (`notify`, `handback`). Never trim it yourself. Still invalid: stop early as in step 6.
3. **Re-check each issue.** `gh issue view <n> --repo <owner>/<repo> --json state,assignees,title,labels`: drop any that is no longer open, has gained an assignee, or is already a unit of this run (an assignment can fail), and say so.
4. **Save, then close.** Write the batch, each issue's model and trigger, and the report's strategy summary to the checkpoint, then close the pick pane.

`BATCH: none` means nothing is ready now. With units still unfinished or unit PRs still waiting for a merge, it isn't the end: their merges may unblock more, so the next pick waits (see Flow). With every unit finished and tidied, no merge running and no unit PR waiting for a merge, it ends the run as drained: relay the strategy summary and how many issues the report holds as waiting on a response, since those are what hold the backlog. A non-empty pick emptied by the re-check is not drained: with `drain`, pick again; a second such pick stops early as stuck (step 6).

## 2. Start

Run Sync first, and create nothing until it clears. Each issue's branch is `bugfix/issue-<n>-<slug>` with the `bug` label, else `feature/issue-<n>-<slug>`; the slug is the lowercased title with every run of other characters than a-z and 0-9 as one `-`, cut to 40 characters at a hyphen, or `untitled` if nothing is left. Derive both with exactly these reads, one issue at a time, never by splitting `@tsv` with `IFS read` (an empty field collapses, so an unlabelled issue's title lands in the labels and its branch ends `issue-<n>-`):

```bash
J=$(gh issue view <n> --repo <owner>/<repo> --json labels,title)
prefix=$(jq -r 'if any(.labels[]?; .name == "bug") then "bugfix" else "feature" end' <<<"$J")
slug=$(jq -r '.title | ascii_downcase | gsub("[^a-z0-9]+"; "-") | gsub("^-|-$"; "") | if length > 40 then .[0:41] | sub("-[^-]*$"; "") | .[0:40] else . end | if . == "" then "untitled" else . end' <<<"$J")
echo "$prefix/issue-<n>-$slug"
```

`/work` keeps a branch holding its issue number.

```json tool=worktree.createWithRecipe
{"source":{"kind":"newBranch","branchName":"feature/issue-13401-<slug>","baseBranch":"origin/<base>","fromRemote":true,"collisionPolicy":"error","issueNumber":13401,"assignToSelf":true},"focusPolicy":"preserve"}
```

No recipe: it would make each create wait for the user's confirmation, with no notice. `assignToSelf` claims the issue at once so no later pick selects it; an `assignmentError` is only noted (`/work` assigns too). On a lost reply or a collision, look for the branch in `worktree.list`: this run's own create is adopted; any other existing branch fails the unit and is never reused.

Launch only on `setupState: "ready"`. Wait with `worktree.waitUntilReady` (`timeoutMs: 25000`, at most two calls this turn); `timedOut` is the wait running out, not the setup. Not ready yet: stay `setting-up`, re-read with `timeoutMs: 0` on each check. Launch once it is ready and a slot is free, on its model; until a slot frees, it is `queued`. `needs-approval` makes it `blocked`; `failed`, `timed-out` or `unknown` fails it; tidy deletes its worktree with the rest. Then launch `/work <n>` per Every launch, and check the banner on each model's first launch of the batch (Models).

## 3. Watch

A unit's marker is a last reply ending with the line `WORK_COMPLETE`. Then `gh pr list --repo <owner>/<repo> --head <branch> --state all --json number,state,url`: a PR makes it `done`, whatever CI state it reports (the CI gate below deals with that). No PR, with `/work`'s no-change report (`no PR needed`, a Verdict and its Evidence), makes it `no-op`: `/work` has already closed the issue with an evidence comment, so keep the verdict and evidence for the report and confirm the issue is closed. No PR otherwise fails it, and so does `CATASTROPHIC_STOP`. Look up a unit's PR whatever its status: a unit can open its PR and then stop. Nudge text: `Continue the /work pipeline for #<n> from where you stopped, through to WORK_COMPLETE.`

**CI check, per unit.** When a unit is `done` and not yet tidied, read its PR's checks (`gh pr view <pr> --repo <owner>/<repo> --json state,statusCheckRollup`); a check with no conclusion yet is pending. A failed check: read the `GitHub CI` line of `/work`'s final report first. `failures remaining after 3 fixes` or `base-level failure` means `/work` ended its own fix loop on purpose: never send it back. Record the reason; the unit is finished and its PR goes to the merge, which repairs CI on the PRs it takes and fixes a red base. Otherwise (the report said green, or CI went red after it finished), send that unit's agent `Check the CI on PR #<pr> and fix what fails, then continue through to WORK_COMPLETE.` (`notify: true`), set it `running` again, and watch it like any unit. Send that at most once per unit: a second red finish is finished the same way. Not while a running merge has named that PR in its progress: two writers on one branch reject or overwrite each other's pushes, and the merge fixes CI on what it takes, so the PR is handed to the merge and the unit is finished. Pending: check again next time. Green, merged or closed: the unit is finished, so tidy it (step 5) and free its slot. `/work` watches its own CI, so most PRs arrive green. A `no-op` or `failed` unit, or a `skipped` one no longer working, is finished at once.

## 4. Merge

Launch `/merge-prs` whenever none is running and at least one finished unit's PR is waiting for a merge (still open, not deferred or reverted by a completed merge, and not left for the user after a failed one), whatever else is still working. Record the unit PRs open as it starts. Only one at a time: while one runs, newly finished PRs ride it, because it rescans about every 10 minutes and takes in PRs opened while it runs. That rescan can also take a PR whose agent is still watching CI, and two writers on one branch collide: send the merge pane the PRs of units still working as off-limits until each finishes (`notify: true`). If it takes one anyway and pushes to it, tell that unit's agent to fetch before any push and never force-push over the merge's work; if an agent reports a rejected push, or a force-push over the merge's rebase, tell the user.

`/merge-prs` keeps the main checkout on the base and fast-forwards it, so first require `git -C <main path> status --porcelain` to print nothing and the branch to be the base. If not, report it and wait; never switch or clean the checkout yourself. Then launch `/merge-prs` in the main worktree per Every launch (name `Batch <k> · merge`, where `<k>` is the latest batch, no `handback`).

It runs for an hour or more and ends turns by itself while its background agents, train checks and CI watchers run, usually on a `MERGE_WAITING` line, so for this pane idle without a marker is normal: never nudge it on schedule or fail it for stopping. Only a `CATASTROPHIC_STOP` line (a halt puts it at the top of the reply, with the evidence below) or an exited process fails it; a failed merge keeps its pane for the user, its open unit PRs are left for the user, and the run stops early (step 6). After 60 minutes idle with no output change, take one screen read. A last line starting with `MERGE_WAITING` is still a pause: report it as possibly stuck and keep waiting, never nudge. Otherwise nudge once (`Continue the merge pipeline.`), then report it as stuck and keep waiting. Never close a merge pane that is still running or idle without its marker. It never asks the user anything: it decides in place of each question and lists those decisions in its summary. Its last reply between turns ("#<pr>'s train check passed… it merges once `ci-ok` is green") is the cheapest progress read; its state file, `.tmp/prs-merge-state.json` in the main worktree, says which PRs it has taken.

It merges in trains: several PRs land together once a train check passes, and their issues close as they land. It also lands any other eligible PR in the repository, the user's own branches included.

Its marker is a last reply with `**MERGE PIPELINE COMPLETE**` on a line of its own, after a short cleanup line; the summary under it runs long, so read with `maxBytes: 16000` and page back with `message.nextCursor` to the reply's start. The phrase inside progress text is not a finish. Then `gh pr view <pr> --repo <owner>/<repo> --json state,mergedAt` for every unit PR it could have served, record each unit PR's outcome, and carry the summary's Reverted, Deferred (soft and hard), Decisions made in place of a question, and Final base lines into your report. A reverted PR is not landed; its branch and PR stay for the user. A hard defer is labelled `human.review` and needs the user. Then close the merge pane with `terminal.closeMany`: it is closed only when its `results` item is `ok` and its `result.closedIds` holds the pane's id. Apply Flow at once: finished PRs still waiting for a merge start the next one, and landed work may have unblocked issues for a pick.

## 5. Tidy

Runs for each unit as soon as it is finished (see step 3), whatever its status: `done` with green CI or handed to a merge, `no-op`, `failed`, `skipped`, or a setup that never became ready. It never waits for the merge: the branch is on origin. From then on the PR is the merge's: it fixes what its own rebase breaks, and what it defers or reverts is reported, never handed back to a `/work` agent. Before closing a pane, its unit's outcome and reason are already in the checkpoint, because the report is all the user has once it's gone. Units finishing together can be tidied together.

1. **Check the worktree.** `git -C <path> status --porcelain` must print nothing, and `terminal.list` with its `worktreeId`, once as is and once with `location: "background"`, must list no pane this run didn't open. A dirty tree is uncommitted work that `worktree.deleteOwned` never forces past, and a foreign pane means the user is working there: keep that worktree and its pane, and report why. A failed read keeps it too.
2. **Close its pane** if still open, with `terminal.closeMany`. A pane is closed only when its `results` item is `ok` and its `result.closedIds` holds the pane's id. A unit that never launched a pane, or whose pane `terminal.list` no longer shows, goes straight to delete. A pane that won't close keeps the worktree.
3. **Delete the worktree** with `worktree.deleteOwned` and the unit's worktree id, one at a time. The branch stays. Record each outcome: `CONFIRMATION_TIMEOUT` is pending, `USER_REJECTED` is kept, and `RESOURCE_NOT_OWNED` (see Resume) is kept and listed for the user. None is retried automatically, and none holds a slot, a pick or a merge.

## 6. Report

Report as things happen, in a line or two: a unit finished (its model, PR, CI and a sentence on what it did, plus anything it flagged for the user), a batch started (issues, their models and where they run), a merge started or finished (what landed). Every few hours, or when asked, a fuller status: units working, PRs open and landed, what is blocked or pending, issues left. A check that changes nothing ends with one short line.

The run ends normally only when a pick returns `BATCH: none` with every unit finished and tidied, no merge running and no unit PR waiting for a merge (without `drain`: when its one pick's units have finished and been tidied, no merge is running and none of their PRs is waiting for a merge, which holds at once when they opened none). It stops early, reported as stuck rather than drained, when:

- a merge failed;
- every unit of a batch failed; or
- a completed merge landed none of the unit PRs open when it started.

Stopping early sets phase `stopping`: no more picks, and no create or launch for a unit not yet started; tidy those at once and list their issues as assigned. `stopAfterRound` sets `stopping` too, but only ends the picks: units already picked still launch as slots free. Either way, units working and a merge running finish and are watched, gated and tidied as usual, and finished PRs still get a merge unless a merge failed. Supervision ends only once every unit is finished and tidied or was tidied unstarted (a `blocked` or `setting-up` unit keeps it going), no pick or merge is running, and no unit PR is waiting for a merge: then the final report, `CronDelete` and phase `done`.

## Flow

Every check, and every finish, ends here. Keep the slots full and the merges flowing; nothing waits for a batch to finish.

- **Optimise for throughput.** The measure is issues landed per hour, which is the slot count over the average `/work` time while every slot is busy. A pick takes about 15 minutes, so a slot that frees with nothing queued idles that long: keep work queued.
- **Refill early, with `drain` only.** Start a pick when the phase is `running`, no pick is running, and the slots free or about to be (the cap minus units still working, counting a unit with its PR up and only CI to wait for as about to be, then minus units already `setting-up` or `queued`) reach about a quarter of the cap, at least 2 (or the cap, when it is smaller). With a large ready backlog, ask for that many plus about a quarter of the cap more, so a queue is waiting when the next slots free. Overlap is safe because every create assigns its issue, `/next-batch` never selects an assigned one, and the re-check drops this run's own units.
- **Start as soon as the pick is in.** Sync, then create and launch into the free slots. Issues beyond the free slots wait as `queued` and launch, in pick order, as slots free; create their worktrees at once, so their issues are assigned and no other pick takes them. Right before a queued issue launches, bring its branch up to everything that merged while it waited: `git -C <path> fetch --quiet origin <base> && [ -z "$(git -C <path> status --porcelain)" ] && [ "$(git -C <path> rev-list --count origin/<base>..HEAD)" = 0 ] && git -C <path> merge --ff-only --quiet origin/<base>`, with `<path>` the worktree path its create returned (on a worker, through `project.runCommand` there). It moves nothing when the worktree has changes or a commit of its own; a non-zero exit is only noted, and the issue launches on what it has.
- **Dependencies follow merges.** A blocker counts as done only once its PR has merged and closed the issue, so `/next-batch` never picks work whose blockers are still in flight, and the sync before each create puts that work on top of them. Keep merges flowing, or chains like a tracker's waves stall.
- **Short and empty picks.** When a pick fills fewer slots than are free, or returns `BATCH: none`, because the rest wait on PRs not yet merged, launch what it found. The next pick then waits until a merge lands a PR, or until every unit has finished with no unit PR waiting for a merge, whichever comes first; free slots alone don't start it.
- **Merge early and often** (step 4): the first finished PR is reason enough to start one, not a whole batch. Landing work early unblocks dependency chains and keeps rebases small.
- **Stop conditions still apply** (step 6). `stopAfterRound` ("stop after this batch") stops new picks; a pick already running finishes and its issues are not started.

## The user mid-run

- "status": report from the checkpoint and a fresh status read; send, nudge, count and advance nothing.
- "stop after this batch": set `stopAfterRound` in the checkpoint now.
- "stop now": set `cancelled`, delete the cron, launch and send nothing more, and leave running agents alone. Report what is still running.
- "go on without <host>": leave that host out of the run's syncs from now on, and say so in each report.
- "skip #n": takes it out of the run's required outcomes. A unit still working keeps its slot until it stops; interrupt it (`terminal.interruptOwned`) only if the user says so.
- A new batch size, split, model override or Opus cap: record it with the time and apply it from the next pick (Models); agents already running keep theirs. Read any optional part it brings in.
- "drain" or "continue": set drain, clear `stopAfterRound`, and go back to phase `running` from `stopping`. After a `done` or `cancelled` run this starts a new run with a new id, from Preflight.

## Resume

On `resume`, or a check that finds this skill missing from your context: read the checkpoint, and stop there if it is `cancelled` or `done`. Read the optional parts it lists. `CronList`, and recreate the cron if it is missing or older than 6 days. Before any launch, reconcile with live state: `terminal.list` (the `Batch` panes), `worktree.list` (`issueNumber`, `issue-<n>` branches) and `gh pr list --repo`. Then re-arm `terminal.notifyWhenIdle` on working panes and continue from the phase shown.

A checkpoint carries ids, not authority. The same help session reconnecting keeps what it created, but a new help session can read and close earlier panes and owns none of their worktrees, so `worktree.deleteOwned` refuses those with `RESOURCE_NOT_OWNED`: tidy lists them for the user instead.

With no checkpoint, never infer size, drain or filters. Report the `Batch` panes you find, merge panes included even when idle, as unresolved earlier work, and ask the user how to go on.

## Final report

- Batches run, and each issue with its model, PR and final state, plus the run's Sonnet/Opus split.
- Hosts left out of a sync or still held, with why.
- Failed, blocked, reverted and unlanded units, with their branch, PR and why they didn't land.
- Issues this run assigned that have no landed PR. An assigned issue never reaches a later `/next-batch`, so the user may want to unassign them.
- Every worktree this run created that is still on disk, with its path, pane name and why: dirty, a foreign pane, delete pending or refused, or a run that stopped before tidy.
- Anything you could not verify.
