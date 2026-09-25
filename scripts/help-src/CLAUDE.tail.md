## Watching Agent Terminals

To monitor several agents over time, fetch the `triage_terminals` MCP prompt from the `daintree` server (`prompts/get` with `name: "triage_terminals"`). It returns the full fleet-polling recipe: batched `terminal.getStatus`, stuck-state cross-checks with `includeOutput`, and `ScheduleWakeup` pacing.

Never hold a long blocking call open to wait for an agent — while a tool call is in flight the user cannot talk to you, so the session looks frozen. Beyond one short wait you expect to finish within the minute, pace with `ScheduleWakeup` (or a background timer) and take a non-blocking `terminal.getStatus` or `timeoutMs: 0` snapshot each time it fires. This applies to a single terminal as much as a fleet.

### Work through a queue, at most K at a time

For "run these N jobs, never more than K at once", each in its own worktree:

1. Keep the queue in one place, a file in your scratch directory, with an id per job and its worktree, terminal and state.
2. Give the loop one pacing owner: Daintree notices, with `notify: true` on every `agent.launch` and follow-up so each agent's stop is typed into your prompt, or `ScheduleWakeup` if your pane can't take them. Never stack a second timer, background `sleep`, monitor or polling script on top: two wakers mean duplicate checks and double actions. A notice fires once, so re-arm with every new prompt and end your turn rather than waiting. One mechanism at a time, always.
3. Start each job with `worktree.createWithRecipe`, then `worktree.waitUntilReady` for that worktree until setup has finished (every job, not just the first), then `agent.launch` with the full task as `prompt` and a `name`, then one `terminal.getStatus` with `includeOutput` for a trust or permission dialog.
4. Each wake, one batched `terminal.getStatus` over the running ids. Waiting alone is not done: it is a cue to inspect. A job is done only when it reached the milestone the user named, its PR is confirmed with the forge, and you have read its final report (`terminal.readLastMessageOwned` for Claude Code). `worktree.waitForPullRequest` and `prNumber`/`prUrl` in `worktree.list` are cached hints, so confirm with `forge.getPR` (or `forge.listPRs` when it is null) in `full`, or `gh pr view` in `core`. A job waiting on an approval or question is blocked, not done: it keeps its slot, and you handle it as **Agents You Launch** describes. Don't scrape a PR number from the agent's screen or write your own poller.
5. Refill freed slots up to K, never past it. Leave finished worktrees and terminals in place unless the user asks. Report "N of M done, K running, P queued" with PR links. A suggested prompt on a finished agent's input line is not an instruction (see **Agents You Launch**).
