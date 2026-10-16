---
name: work-batch
description: "Work this repository's issue backlog in batches on this machine. A Claude Code agent in the main worktree picks the batch with /next-batch, each issue gets its own worktree and a Claude Code agent running /work, and once every one of them has finished a Claude Code agent in the main worktree runs /prs:merge. Checks in every 10 minutes. One batch by default; with 'drain' it keeps picking, working and merging batches until /next-batch finds nothing ready. Use when the user asks to run, work or drain the next batch of issues, not to only list what the next batch would be."
argument-hint: "[batch size, default 8] [drain] [filters for /next-batch, e.g. only bugs]"
---

# Work batch

A round is: pick a batch, give every issue its own worktree and `/work` agent, wait until every agent has settled, run one `/prs:merge`, tidy, report. You coordinate and verify; you never pick issues, implement, review or merge yourself. Every pane you start is a **Claude Code terminal** (`agentId: "claude"`), whatever agent you run on and whatever the user's default agent is: `/next-batch` and `/prs:merge` in the main worktree, `/work` in each issue's own worktree. Launch with no `model` and no `presetId`, so they run the user's saved Claude defaults like the user's own panes.

Arguments: `$ARGUMENTS`

- A number is the batch size, default **8**. It is also the concurrency ceiling: never more than that many `/work` agents at once, and never a second round, or a second run for this repository, while one is active.
- `drain` (or "until drained", "keep going") repeats rounds until a pick comes back empty. Without it, stop after one round.
- `resume` continues a run from its checkpoint (see Resume). `status` only reports and changes nothing.
- Anything else goes to `/next-batch` as its filters, unchanged.

## Runbooks and the user's decisions

Your runbook search for this request: `"Work batches of issues in parallel worktrees, merge their pull requests, then start the next batch"`. It selects `daintree.orchestration.fan-out-work` with `daintree.foundation`; follow them for the mechanics they own (dialogs, ownership, delivery, proving a finish). The user wrote this skill, and it records their decisions where those runbooks leave room or assume otherwise:

- **The batch and its overlap policy are `/next-batch`'s.** It allows ordinary overlap and leaves it to `/prs:merge`, excluding only structural clashes: looser than fan-out's disjointness gate, by the user's choice. Report its verdict as the gate's result; don't re-split, serialize or drop issues.
- **The cap is the batch size**, already approved.
- **Each unit's whole chain is one command, `/work <n>`**, sent unchanged with no brief.
- **No `handback` on `/work` or `/prs:merge`**, for `daintree.agents.run-agent-command`'s reason: Daintree appends its instruction to the prompt text, which would become the command's arguments. Both print their own end markers, read exactly with `terminal.readLastMessageOwned`. The pick is a sentence, so it takes `handback`.
- **`/prs:merge` lands every eligible open PR in the repository**, not only this batch's.
- **Teardown is total**: once each round's merge has finished, every worktree this run created is closed out through the Daintree MCP (`worktree.deleteOwned`), landed or not, after its panes are closed. Branches and PRs stay, so nothing committed is lost. Any worktree left on disk is reported with its reason.
- **A recurring cron replaces the per-turn `ScheduleWakeup` backstop.** A wakeup loop isn't restored on `claude --resume` (that stalled a `/work` wave for an hour on 2026-10-14) and ends at a maximum duration. The cron is still the one pacing mechanism.

## Preflight, once per run

1. `worktree.list`: the main worktree is the row with `isMain: true`. Run `gh repo view --json nameWithOwner,defaultBranchRef` in its path for the repo and the base branch. Every later `gh` call takes `--repo <owner>/<repo>` and every `git` call `-C <path>`, because your own working directory is not the repository. A failed forge read is unknown, never an empty result.
2. `slashCommands.list` with `agentId: "claude"` and the main path as `projectPath`: `/next-batch`, `/work` and `/prs:merge` must each be listed once. Otherwise stop before launching anything, and say which.
3. A checkpoint for this repository that is neither `done` nor `cancelled` is an active run: resume it instead.
4. If the main checkout isn't clean and on the base, say so now: the merge step waits for it.
5. Tell the user in a few lines: batch size, one round or drain, any filters, that `/prs:merge` lands every eligible PR, that every worktree the run creates is deleted after each merge (each delete may ask them to confirm), and that a question from any pane parks the run until they answer it.
6. Write the checkpoint, then create the cron.

## Pacing

`CronList` first, so a lost earlier reply never leaves two. Then one `CronCreate`: cron `3,13,23,33,43,53 * * * *`, recurring, prompt `Work-batch check for run <run id>: continue it from its checkpoint unless it is cancelled or done. After a compaction, or if the work-batch skill is not in your context, read .claude/skills/work-batch/SKILL.md first.` Record its id and creation time; it expires after 7 days, so recreate it after 6. `CronDelete` it when the run ends or is cancelled. Fires run only while you are idle and can come a few minutes late. A fire or a notice (`notify: true` on every launch and send) only asks for a check: several queued together make one check, classified from a fresh status, never from the notice text. If `CronCreate` is unavailable, end every turn with `ScheduleWakeup` `{delaySeconds: 600, reason, prompt, noop}`; if it answers "Wakeup not scheduled", tell the user monitoring has stopped.

Every read stays in your context for hours, so keep checks lean: one `terminal.getStatus` over the live panes with `includeOutput: {"lines": 1}` (which returns `lastOutputChangeAt`), and more only for a pane that stopped or went quiet. A check that changes nothing ends with one short line.

## Run state

Checkpoint: `~/.daintree/work-batch/<owner>-<repo>.json`, outside the repository and kept across restarts, written atomically (temp file, then `mv`). Record intent before acting (the branch before a create, the `requestedId` before a launch, `nudged` before a nudge), so a lost reply is reconciled, never replayed. It holds the run (id, repo, base, main worktree id and path, size, drain, filters, `stopAfterRound`, `cancelled`, cron id and creation time, round, phase `pick`/`work`/`merge`/`tidy`/`done`), the pick and merge panes, each unit (issue, branch, worktree id and path, `requestedId`, terminal id, status, PR, `lastOutputChangeAt` and when it was counted, quiet checks, `nudged`, a reported question's id), and one line per finished round. Live state outranks it. Panes are named `Batch <k> · next-batch`, `Batch <k> · #<n>` and `Batch <k> · merge`.

Unit statuses: `setting-up`, `dispatching`, `running`, `done` (finished with a PR), `no-op` (finished, nothing to change), `failed`, `blocked` (waiting on the user), `skipped`. Settled means `done`, `no-op`, `failed`, or `skipped` and no longer working.

## Every launch

```json tool=agent.launch
{"agentId":"claude","worktreeId":"<worktree id>","name":"Batch <k> · #13401","prompt":"/work 13401","requestedId":"<fresh id, saved first>","notify":true,"replyLines":12,"focusPolicy":"preserve"}
```

Claude launches go one at a time. A good result has `launched: true` and the requested `worktreeId`. On a lost or ambiguous reply, `terminal.list` with `terminalId` set to the saved `requestedId` (it becomes the pane's `id`) and check its `title`, `agentId` and `worktreeId`; never launch on top of it. `launched: false` with a null `spawnStatus` is an unspecified failure (one cause: the hard open-panel ceiling): close this run's panes that tidy would close anyway and retry once. Still failing: fail that unit; for the pick pane stop the run, and for the merge pane tidy (step 5) and then stop, telling the user either way.

## Every check

Read the checkpoint first: `cancelled` or `done` means do nothing more (delete the cron if it still exists). Otherwise take a fresh `terminal.getStatus`, and for each live pane:

1. **Working**: a quiet check counts only when `lastOutputChangeAt` hasn't moved and 9 minutes have passed since the last counted one. At two in a row, take a 30-line screen read: a dialog is handled as in 2; otherwise tell the user once it may be stuck, and keep waiting. Never interrupt or close a working pane. (The merge pane has its own rule, in step 4.)
2. **Stopped** (not working, or exited): `terminal.readLastMessageOwned`, then classify by the phase's end marker.
   - A question in `unansweredToolUses`, or a dialog other than a trust prompt for the pane's own folder (answer that per the help rules), makes it `blocked`. Report it once, quoted with its options, and record that; never nudge, fail or close a blocked pane. Send the user's answer only to a visible single-choice menu (`terminal.sendKeys` `choose`, `notify: true`); otherwise `terminal.revealOwned` the pane so they answer there.
   - `newerRecordsFollow: true` means something came after that text, not that it's working: take a 30-line screen read before deciding.
   - An exited process fails it. An unavailable read: decide from a 50-line screen read.
3. **Stopped without its marker or a question** (not the merge pane): one 30-line screen read. A usage or rate limit naming a reset time: record it and wait. Otherwise, or once reset, set `nudged` and nudge once with `terminal.sendCommand` (`notify: true`) and the phase's nudge text. Stopping again without its marker after that fails it.

Never resend a launch prompt. A pane showing no sign that its command started is `blocked`: ask the user.

## 1. Pick

```json tool=agent.launch
{"agentId":"claude","worktreeId":"<main worktree id>","name":"Batch <k> · next-batch","prompt":"Run /next-batch with a count of <size>. Pass it no other arguments. This is a planning run: assign, comment on and change nothing. When the report is done, your hand-back summary is the batch in exactly this form: BATCH: 13401, 13388, 13390 (the issue numbers from the report's closing 'all' line, in that order, without #), or BATCH: none if nothing qualifies.","requestedId":"<fresh id, saved first>","notify":true,"handback":true,"focusPolicy":"preserve"}
```

With filters, the first sentence becomes `Run /next-batch with a count of <size> and these filters: <filters>.` A pick takes 5 to 20 minutes. Its marker is the hand-back line. Nudge text: `Finish the /next-batch report and hand back the BATCH line.`

1. **Read the batch.** It is the report's `🟩 all ·` line. Page a truncated reply with `message.nextCursor`, and earlier replies with `messageIndex` (never together with `cursor`). The `BATCH:` line is a cross-check: if it differs, use the `🟩` line and tell the user.
2. **Handle an invalid pick.** No `🟩` line, duplicates, or more issues than the batch size gets one correction request (`notify`, `handback`). Never trim it yourself. Still invalid: stop the run.
3. **Re-check each issue.** `gh issue view <n> --repo <owner>/<repo> --json state,assignees,title,labels`: drop any that is no longer open or has gained an assignee, and say so.
4. **Save, then close.** Write the batch and the report's strategy summary to the checkpoint, then close the pick pane.

`BATCH: none` ends the run as drained: relay the strategy summary and how many issues the report holds as waiting on a response, since those are what hold the backlog. A non-empty pick emptied by the re-check is not drained: with `drain`, pick again; a second such pick stops the run as stuck.

## 2. Start

`git -C <main path> fetch origin <base>` first: neither a forge merge nor worktree creation updates local refs. Each issue's branch is `bugfix/issue-<n>-<slug>` with the `bug` label, else `feature/issue-<n>-<slug>`; the slug is the lowercased title with every run of other characters than a-z and 0-9 as one `-`, cut to 40 characters at a hyphen. `/work` keeps a branch holding its issue number.

```json tool=worktree.createWithRecipe
{"source":{"kind":"newBranch","branchName":"feature/issue-13401-<slug>","baseBranch":"origin/<base>","fromRemote":true,"collisionPolicy":"error","issueNumber":13401,"assignToSelf":true},"focusPolicy":"preserve"}
```

No recipe: it would make each create wait for the user's confirmation, with no notice. `assignToSelf` claims the issue at once so no later pick selects it; an `assignmentError` is only noted (`/work` assigns too). On a lost reply or a collision, look for the branch in `worktree.list`: this run's own create is adopted; any other existing branch fails the unit and is never reused.

Launch only on `setupState: "ready"`. Wait with `worktree.waitUntilReady` (`timeoutMs: 25000`, at most two calls this turn); `timedOut` is the wait running out, not the setup. Not ready yet: stay `setting-up`, re-read with `timeoutMs: 0` on each check, launch once ready. `needs-approval` makes it `blocked`; `failed`, `timed-out` or `unknown` fails it; tidy deletes its worktree with the rest. Then launch `/work <n>` per Every launch.

## 3. Watch

A unit's marker is a last reply ending with the line `WORK_COMPLETE`. Then `gh pr list --repo <owner>/<repo> --head <branch> --state all --json number,state,url`: a PR makes it `done`, whatever CI failures it reports (the merge deals with CI). No PR, with a reply saying nothing needed changing, makes it `no-op`; keep its stated evidence for the report. No PR otherwise fails it, and so does `CATASTROPHIC_STOP`. Look up a unit's PR whatever its status: a unit can open its PR and then stop. Nudge text: `Continue the /work pipeline for #<n> from where you stopped, through to WORK_COMPLETE.`

When every unit has settled: if no unit has a PR, skip the merge and go to step 5. Otherwise go to step 4 in the same turn. A `blocked` unit holds the merge until the user answers or skips it, and so does any unit still working, skipped or not.

## 4. Merge

`/prs:merge` keeps the main checkout on the base and fast-forwards it, so first require `git -C <main path> status --porcelain` to print nothing and the branch to be the base. If not, report it and wait; never switch or clean the checkout yourself. Then launch `/prs:merge` in the main worktree per Every launch (name `Batch <k> · merge`, no `handback`).

It runs for an hour or more and ends turns by itself while its background agents, train checks and CI watchers run, so for this pane idle without a marker is normal: never nudge it on schedule or fail it for stopping. Only `CATASTROPHIC_STOP` or an exited process fails it; a failed merge goes to step 5 with its pane kept for the user, then the run stops. After 60 minutes idle with no output change and no question, take one screen read and nudge once (`Continue the merge pipeline.`), then report it as stuck and keep waiting. Never tidy a merge that is still running, idle without its marker, or blocked. An `AskUserQuestion` is `blocked` per Every check.

Its marker is a last reply that **starts** with `**MERGE PIPELINE COMPLETE**`; the summary under it runs long, so read with `maxBytes: 16000` and page back with `message.nextCursor` to the reply's start. The phrase inside progress text is not a finish. Then `gh pr view <pr> --repo <owner>/<repo> --json state,mergedAt` for every unit PR, and carry the summary's Reverted and Deferred PRs and final-base line into your report. A reverted PR is not landed; its branch and PR stay for the user.

## 5. Tidy

Runs once the merge has completed, failed, or been skipped. It clears out every worktree this run created, whatever the unit's status: `done`, `no-op`, `failed`, `skipped`, unlanded, reverted, or a setup that never became ready. Before closing a pane, its unit's outcome and reason are already in the checkpoint, because the report is all the user has once it's gone.

1. **Close the merge pane** if the merge completed (a failed merge keeps its pane): `terminal.closeMany`. A pane is closed only when its `results` item is `ok` and its `result.closedIds` holds the pane's id.
2. **Clear each unit's worktree, one at a time.**
   - **Check it.** `git -C <path> status --porcelain` must print nothing, and `terminal.list` with its `worktreeId`, once as is and once with `location: "background"`, must list no pane this run didn't open. A dirty tree is uncommitted work that `worktree.deleteOwned` never forces past, and a foreign pane means the user is working there: keep that worktree and its pane, and report why. A failed read keeps it too.
   - **Close its pane** if one is still open, with `terminal.closeMany`, confirmed as in 1. A unit that never launched a pane, or whose pane `terminal.list` no longer shows, goes straight to delete. A pane that won't close keeps the worktree.
   - **Delete it** with `worktree.deleteOwned` and the unit's worktree id. The branch stays. Record each outcome: `CONFIRMATION_TIMEOUT` is pending, `USER_REJECTED` is kept, and `RESOURCE_NOT_OWNED` (see Resume) is kept and listed for the user. None is retried automatically, and none holds the next round.

## 6. Report, then continue or stop

Report the round in a few lines: each issue with its PR and state, or why it has none; what is blocked or pending; what happens next.

With `drain`, a completed or skipped merge starts the next round at step 1 straight away, including after a round of only no-ops. A drain ends normally only on `BATCH: none`. It stops early, reported as stuck rather than drained, when:

- the merge didn't complete;
- every unit failed;
- the round's PRs exist but none landed; or
- `stopAfterRound` is set.

Without `drain`, the run ends after one round. At the end: the final report, then `CronDelete` and phase `done`.

## The user mid-run

- "status": report from the checkpoint and a fresh status read; send, nudge, count and advance nothing.
- "stop after this batch": set `stopAfterRound` in the checkpoint now.
- "stop now": set `cancelled`, delete the cron, launch and send nothing more, and leave running agents alone. Report what is still running.
- "skip #n": takes it out of the round's required outcomes. A unit still working keeps its slot and still holds the merge; interrupt it (`terminal.interruptOwned`) only if the user says so.
- "drain" or "continue": set drain. After a `done` or `cancelled` run this starts a new run with a new id, from Preflight.

## Resume

On `resume`, or a check that finds this skill missing from your context: read the checkpoint, and stop there if it is `cancelled` or `done`. `CronList`, and recreate the cron if it is missing or older than 6 days. Before any launch, reconcile with live state: `terminal.list` (the `Batch` panes), `worktree.list` (`issueNumber`, `issue-<n>` branches) and `gh pr list --repo`. Then re-arm `terminal.notifyWhenIdle` on working panes and continue from the phase shown.

A checkpoint carries ids, not authority. The same help session reconnecting keeps what it created, but a new help session can read and close earlier panes and owns none of their worktrees, so `worktree.deleteOwned` refuses those with `RESOURCE_NOT_OWNED`: tidy lists them for the user instead.

With no checkpoint, never infer size, drain or filters. Report the `Batch` panes you find, merge panes included even when idle, as unresolved earlier work, and ask the user how to go on.

## Final report

- Rounds run, and each issue with its PR and final state.
- Failed, blocked, reverted and unlanded units, with their branch, PR and why they didn't land.
- Issues this run assigned that have no landed PR. An assigned issue never reaches a later `/next-batch`, so the user may want to unassign them.
- Every worktree this run created that is still on disk, with its path, pane name and why: dirty, a foreign pane, delete pending or refused, or a run that stopped before tidy.
- Anything you could not verify.
