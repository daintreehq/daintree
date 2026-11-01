# Scheduled runs

A project can run an agent on a schedule (#15973). A due schedule launches its agent as an ordinary agent terminal in the project, every run is recorded (skipped ones included), and a run whose terminal is closed resumes like any historic agent chat. This doc is the contract the rest of the programme builds on: what a schedule is, what a run record is, and when a schedule is next due. Each child that lands keeps it current.

| Part | Code |
| --- | --- |
| Schedule and run record schemas | `shared/types/scheduledRuns.ts` |
| Cron parsing, time-zone checks, next and previous occurrences | `shared/utils/cron.ts` |
| New-schedule defaults, occurrence keys, outcomes, cadence validation | `shared/utils/scheduledRuns.ts` |
| Field-level reasons a schedule can't be stored | `shared/utils/scheduleValidation.ts` |
| A project's stored schedules and their change listeners | `electron/services/ScheduleStore.ts`, `electron/services/schedulesCodec.ts` |
| Editing them from a view (`window.electron.schedules`) | `electron/ipc/handlers/schedules.ts`, `shared/types/ipc/schedules.ts` |
| Run history: the `scheduled_runs` table, registration, recorded facts | `electron/services/scheduledRuns/` |
| Run history over `window.electron.scheduledRuns` | `electron/ipc/handlers/scheduledRuns.ts` |
| Schedule provenance on terminals, snapshots and session records | `shared/utils/scheduledRunProvenance.ts` |
| A cadence in words | `shared/utils/cronDescription.ts` |
| The cadence picker, and reading an expression as a picker state | `src/components/Schedules/CadencePicker.tsx`, `src/components/Schedules/cadenceChoice.ts` |
| The Schedules view and the `schedules.open` action | `src/components/Schedules/`, `src/services/actions/definitions/scheduleActions.ts` |
| Launching a run, routing it to a view or main, refusals | `electron/services/scheduledRuns/ScheduledRunLauncher.ts`, `scheduledRunLaunchLive.ts`, `scheduledRunViewBridge.ts`, `src/hooks/useScheduledRunLaunchBridge.ts` |
| Registering a run at its terminal's spawn | `electron/services/scheduledRuns/scheduledRunAdmission.ts`, called from `electron/ipc/handlers/terminal/lifecycle.ts` |
| Run now (`window.electron.schedules.runNow`, `schedules.runNow`) | `electron/ipc/handlers/schedules.ts`, `src/services/actions/definitions/scheduleActions.ts` |
| The run's handback instruction and its markers | `shared/types/handback.ts`, `shared/utils/handback.ts`, `electron/services/pty/HandbackDetector.ts`, `electron/services/pty/runHandback.ts` |
| The done policy | `electron/services/scheduledRuns/ScheduledRunDonePolicy.ts`, `scheduledRunDonePolicyLive.ts`, `src/hooks/useScheduledRunFinishBridge.ts` |

## Boundaries

- Schedules live in Daintree's local per-project data, never in the repository's `.daintree/`. A `git pull` must never add or change a job that runs an agent unattended, often with permission prompts skipped.
- A schedule launches one agent. Recipes aren't the vehicle: running one needs a window, and main refuses it with no view (`refuseRecipeWithNoView`).
- Completion and settlement act on facts only: a process exit, a marker the agent printed, a precondition's exit code. Heuristic agent state never closes, replaces or settles a run.
- No new MCP tools. Schedule actions are registered in the action system but exposed on no MCP tier.
- Projects on Remote Hosts are out of scope.
- Daintree doesn't wake or power on a sleeping machine on macOS or Linux; the OS runs a missed job when the machine next wakes.

## Schedule

`ScheduleSchema` is the record on disk, and every field is required: loading a record never fills in a default, so a stored schedule can't silently pick up the current machine's zone or a changed default. Defaults apply once, in `createSchedule`.

| Field | Meaning | New schedule |
| --- | --- | --- |
| `id`, `projectId`, `name` | Identity; the name is non-blank | from the caller |
| `enabled` | Whether it fires | `true`: creating a schedule is the opt-in |
| `cadence.cron` | Five-field cron expression | `0 9 * * *` |
| `cadence.timeZone` | IANA zone the expression is read in | the machine's zone, fixed at creation; a given zone is stored under the name `Intl` resolves it to |
| `launch.agentId`, `launch.prompt` | The agent and its first turn; the prompt is non-blank and kept verbatim | from the caller |
| `launch.presetId` | A saved launch preset; `null` launches with no preset, as an explicit `null` does for `agent.launch` | `null` |
| `launch.worktreeId` | Worktree id (its normalized path); `null` is the project's main checkout, never whichever worktree is active | `null` |
| `policies.missedRuns` | `run-once-late` (missed occurrences coalesce into one late run) or `skip` | `run-once-late` |
| `policies.overlap` | When the previous run hasn't settled: `skip`, `start-another`, or `replace` it | `skip` |
| `policies.precondition` | `{ command }`, a shell command that must exit 0 for the run to go ahead, or `null` | `null` |
| `policies.onDone` | When the agent reports done: `keep` the terminal, move it to the `background`, or `close` it with its session still resumable | `keep` |
| `policies.runWhenClosed` | Whether an OS job starts Daintree without a window so the schedule fires when Daintree isn't running | `false` |
| `createdAt`, `updatedAt` | Epoch ms | the creation time |

The zone is stored by name rather than as "follow the machine" so that travelling, or changing the system zone, doesn't move a job nobody is watching.

## Storage and editing

A project's schedules live in `schedules.json` in its state directory under userData (`projects/<id>/`, beside `settings.json` and `recipes.json`), as `{ "_schemaVersion": 1, "schedules": [...] }` in creation order. `ScheduleStore` is given that directory's root and project ids, never a repository path, so nothing in a project's `.daintree/` is ever read. `ProjectStore.schedules` owns the one instance.

- **Read whole or not at all.** A file that isn't JSON, has an unknown top-level key, holds a record `ScheduleSchema` refuses, files a record under another project, or repeats an id is moved aside to `schedules.json.corrupted.<time>` and read as no schedules; one from a newer build goes to `schedules.json.future-v<N>`. A record is never dropped on its own: every schedule runs an agent unattended, so losing one silently is as wrong as running one this build can't represent. If the file can't be moved aside, the call fails and nothing writes over it. Quarantined files are swept after 30 days with the project's others.
- **One turn at a time.** Every read and write for a project takes a turn in a per-project queue, so two edits never build on the same snapshot.
- **Main mints identity.** A new schedule takes its id (a UUID), project and times from main and its defaults from `createSchedule`. An edit replaces whole parts (`name`, `cadence`, `launch`, `policies`); `id`, `projectId` and `createdAt` never change, and `enabled` changes only through `setEnabled`. Each change stamps `updatedAt` strictly later than the stored one, even if the clock went back.
- **Edits are checked against the version they were made from.** `update` names the `updatedAt` it edited; a schedule changed since, in any window, is refused as a `conflict` carrying the newer version. Enabling, disabling and deleting state an intent and take no version.
- **A bad value is an outcome, not an error.** Create and update answer `invalid` with every `ScheduleIssue`: the field's dotted path (`cadence.cron`, `launch.prompt`), the cron field when the expression names one, and the schema's message. Thrown errors are logged, so they carry no prompt or command; a request of the wrong shape is refused with a generic `VALIDATION` error.
- **Removing a project removes its schedules.** `ProjectStore.removeProject` deletes the project's row, then removes its state directory, schedules included, inside a schedule turn of its own. An edit already past its check finishes first, every turn after refuses because the project isn't registered, and an edit for the same project added straight back waits until the old directory is gone.

`window.electron.schedules` (`list`, `create`, `update`, `setEnabled`, `remove`, `onChanged`) works on the sender's own project, resolved from the view's registration; no op takes a project id. `list` answers null for a view not yet bound to a project. A project on a Remote Host, a view attached over a link, and a scratch are refused: the channels are `shell`, so a remote-bound view is answered on this machine and no link reaches them. They are not actions, so they are on no MCP tier.

Every committed change goes to the store's listeners as a full `SchedulesSnapshot`, in commit order per project. Main code (the scheduler and launcher) reads with `list` and `get` and subscribes with `subscribe`, with no window needed. The IPC registration's listener sends `schedules:changed` to every local view of the project, cached views and the writer included, and to no other window. A snapshot's `revision` rises with each change, so a view keeps the newest of a reply and a push that cross. A file edited by hand is not announced.

## The Schedules view

A project's schedules are seen and edited in one dialog, opened from the project pill's context menu ("Schedules…") and the command palette by `schedules.open`. Other surfaces open it at a schedule with `{ scheduleId }`. The action is in no assistant or external MCP tier and is hidden from tool listings, and it is unavailable in a window driving a Remote Host or a scratch.

- **The list** shows each schedule's name, its cadence in words (`describeCron`, or the expression itself when there's no short reading), the agent and a non-main worktree, the next run relative and absolute in the schedule's zone (the zone is named when it isn't this machine's), the last run as the history records it (its outcome, read from the evidence it settled on, and when, or "Running" while it's open), and a switch that applies at once. A switched-off schedule reads "Paused" instead of a next run. The list reads the project's runs again on `scheduled-runs:changed`.
- **A schedule's page** is the editor: name, agent, preset, worktree and prompt; the cadence, missed runs and overlap; the precondition and the done policy. It saves explicitly, because a half-typed prompt or cron must never be committed for an unattended run; leaving with unsaved edits asks first, and an edit made from an older version is refused as a conflict with a way to load the latest. A new schedule takes `createSchedule`'s defaults.
- **The cadence picker** offers every few minutes or hours (steps that divide the hour, and 1-12 hours), every day, every weekday, chosen days and a day of the month, each at a time, plus a custom cron expression. The expression stays what is stored: the page reads it as a picker state when it opens, and each edit writes it again. Each preset writes one text form (Every weekday `1-5`, chosen days a list such as `1,2,3,4,5`), so a picked cadence reopens as it was picked; anything no preset writes opens as custom, kept as written. Moving between kinds keeps the time of day, and custom starts from the expression in use. Under it the cadence reads in words with its next three runs in the schedule's zone, the zone named, and named on the time too when it isn't this machine's.
- **The permission warning** shows when the chosen agent and preset would stop at permission prompts, resolved the way a launch resolves it (`resolveSkipPermissions`), because nobody is there to answer them.
- **Delete** asks first, naming the schedule.

## Cadence

`parseCron` reads standard five-field cron: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `JAN`-`DEC`), day of week (0-7 or `SUN`-`SAT`, with both 0 and 7 meaning Sunday). Each field takes `*`, numbers and names (case-insensitive), comma lists, ascending ranges, and steps on `*` or a range (`*/15`, `5-59/15`). Fields are separated by spaces or tabs on one line.

Day of month and day of week combine as in Vixie cron: when neither field starts with `*`, a day matching either fires (`0 0 1 * FRI` is the 1st and every Friday); when either starts with `*`, a day must match both (`0 0 */2 * MON` is Mondays on odd dates). Starting with `*` is syntax, not membership, and `ParsedCron` keeps it as `dayOfMonthStarred` and `dayOfWeekStarred`.

Refused, each with a reason naming the field that a form can show: a field count other than five, `@daily`-style macros, Quartz syntax (`?`, `L`, `W`, `#`), a step on a single value (`5/15`), a zero step, out-of-range values, backwards or wrap-around ranges (`FRI-MON`; write `FRI-SAT,SUN,MON`), unknown names, and expressions that can never fire (`0 0 30 2 *`). February counts 29 days, so `0 0 29 2 *` is valid and fires in leap years. `validateTimeZone` accepts IANA names and aliases in any case and returns the resolved name; numeric offsets such as `+05:00` are refused because they never follow daylight saving. `validateCadence` runs both and says which field is wrong.

### Daylight saving

Each matching wall-clock minute fires once, at one instant:

- **Clocks go forward.** A minute inside the skipped interval fires at the moment the clocks jump. Every skipped minute lands on that one instant, so it fires once: `30 2 * * *` in New York fires at 03:00 on spring-forward day, and `*/15 * * * *` fires at 03:00 and then 03:15.
- **Clocks go back.** A minute shown twice fires at its first showing only. `30 1 * * *` in New York fires at 01:30 EDT and not again at 01:30 EST, and `0 * * * *` fires once through the repeated hour.

This departs from Vixie cron, which runs wildcard-hour jobs in both passes of a repeated hour. One rule for every expression is easier to predict than one that depends on how the hour field is written. Half-hour shifts (Lord Howe) and a skipped date (Apia, 30 December 2011) follow the same rules.

### Queries

| Function | Returns |
| --- | --- |
| `nextCronOccurrence(cron, timeZone, afterMs)` | The first firing instant strictly after `afterMs` |
| `nextCronOccurrences(cron, timeZone, afterMs, count)` | Up to `count` successive instants, for previews |
| `previousCronOccurrence(cron, timeZone, atMs)` | The last firing instant at or before `atMs`, for catch-up |

In the second pass of a repeated hour, `previousCronOccurrence` can return a minute whose wall clock is later than the one `atMs` shows, because that minute already fired in the first pass. The search walks local calendar dates (skipping those the expression excludes with calendar arithmetic only) and binary-searches each matching date's minutes, which the rules above keep in instant order. The horizon is one 400-year Gregorian cycle, so any expression `parseCron` accepts is found. A wall clock's instant comes from the zone's offsets a day either side, which assumes no zone changes its offset twice within a day of the same minute; tzdb's closest pair of transitions is about a week apart. Queries take times from 1970 through 9999, which keeps a 400-year search clear of the years `Date.UTC` remaps and of the end of `Date`'s range. A time outside that, or a negative count, throws, which is distinct from "no occurrence".

## Run record

`ScheduledRunSchema` is one run of one schedule, written before anything spawns and updated as facts arrive.

- `id`, `scheduleId`, `projectId`, and `createdAt`, the time it was registered.
- `terminalId`: reserved before the launch, so the launch and the record agree on it. A run skipped before one was reserved keeps null.
- `terminalSpawnedAt`: the spawn incarnation of `terminalId` the run was matched to, the PTY host's `spawnedAt`; null until the terminal first spawns.
- `origin`: why the run exists.
- `settlement`, `process` and `pane`: three independent axes, below.
- `resume`: what a closed run's terminal needs to resume.

### Origin and occurrence keys

| `trigger` | Meaning | `dueAt` / `occurrenceKey` | `coalesced` |
| --- | --- | --- | --- |
| `scheduled` | Fired on time while Daintree was running | the occurrence | `null` |
| `catch-up` | Stands for occurrences missed while asleep or closed | the latest missed occurrence | required |
| `os-launch` | Fired by the OS job that started Daintree windowless | the occurrence | when it also catches up |
| `run-now` | The user asked for it | `null` | `null` |

The occurrence key is `occurrenceKeyFor(dueAt)`, the due instant in UTC ISO form, and is unique per schedule: a restart can't run the same occurrence twice. The two showings of a repeated wall clock are different instants, so they'd have different keys, though the cadence only ever produces the first. `coalesced` is the window `(after, through]` a late run stands for, with `dueAt` the latest occurrence inside it, so a long sleep produces one record rather than one per missed occurrence. Under `missedRuns: "skip"` the same record is settled as skipped with reason `missed`. Registering a run and advancing the schedule's evaluation point must commit together, or a rolled-back cursor could replay an older occurrence inside an already-consumed window.

### Settlement, process and pane

The three axes keep three events apart: the run settling, the agent or PTY exiting, and the pane closing. Each moves only on its own event.

- **`settlement`** is `open` until a fact settles it, then `settled` with `settledAt`, an `outcome` and the `evidence`. A settlement never changes once made; the process axes and the resume snapshot's session id can still be filled in after it. Overlap reads this axis: an open run is an unsettled one, so a kept terminal or a conversation the user carries on doesn't hold the next run back.
- **`process`** holds the agent CLI and the PTY separately, because an agent can exit and leave its shell running. Each is `not-started` (no start seen), `running`, or `exited` with its exit code and signal when known. A signal is a positive number or null; producers map node-pty's 0 to null.
- **`pane`** is `none`, `open`, `background` (moved there by the done policy or the user, not merely out of view), or `closed`.

The outcome follows from the evidence (`outcomeForEvidence`), and the schema refuses a record where it doesn't:

| Evidence | Outcome |
| --- | --- |
| `handback`: the marker the agent printed, `done` or `needs-you`, with its summary | `done` / `needs-you` |
| `exit` of the agent or PTY with code 0 and no signal | `done` |
| `exit` with a non-zero code or a signal | `failed` |
| `exit` with no code or signal known | `exited` |
| `launch-error` | `failed` |
| `skip`, with its reason | `skipped` |
| `cancel`: the user stopped the run | `cancelled` |
| `replace`: the overlap policy put `replacedByRunId` in its place | `replaced` |
| `lost`: the PTY host confirmed the terminal is gone with no exit seen | `lost` |
| `interrupted`: Daintree quit or crashed while the run was open | `interrupted` |

A `needs-you` run is settled: the schedule's attempt is over and its terminal stays for the user. Only the agent's `done` handback applies the done policy, never an exit that reads as `done`. A restart that hasn't yet reconnected to a run's terminal is not `lost`. A run Daintree's quit or crash left open is `interrupted`, settled at the next startup.

Skip reasons are `missed` (only for an occurrence, never `run-now`), `overlap` with the `openRunId` that was still open, and `precondition` with its exit code, signal, or the error that stopped it running (an exit 0 isn't a skip). A skipped run never launches: no pane, neither process started, and no resume snapshot. It may hold a reserved terminal id, since registration can reserve one before the precondition runs.

### Resume snapshot

`resume` mirrors `AgentSessionRecordSchema`: `agentId`, `agentSessionId`, `cwd`, `worktreeId`, `agentLaunchFlags`, `agentModelId` and `agentPresetId`. `agentSessionId` is null until captured, and capture can land after settlement.

## Run history

`ScheduledRunRecorder` keeps every run in the `scheduled_runs` table of Daintree's SQLite database (migration 0020): each row is a validated record as JSON beside the columns its queries read. Writes are synchronous, so a write has committed before anyone hears of it. It is opened on first use (`getScheduledRunRecorder()`), and opening it settles what an earlier lifetime left open before any run of this one can be registered.

### Registration

- **`registerLaunch`** records a run about to launch, with its reserved terminal id and its resume snapshot, and commits before it returns, so the launcher spawns only after. Claude's session id is assigned at launch, so it can be in the snapshot from the start. A second run for an occurrence the schedule already has a run for throws `ScheduledRunConflictError` and must not launch; `run-now` runs carry no occurrence.
- **`registerSkip`** records a skipped occurrence, settled at once with its reason. It never launches.
- **`registerRefusedLaunch`** records a run whose launch was refused before its terminal spawned, settled at once as failed (`launch-error`) with the reason and no resume snapshot. Like a skip it neither starts nor ends.
- **`settle`** settles an open run on a fact another service saw: a launch error, a cancel, a replacement. A settled run is left as it is.

### Facts the history records itself

A run is matched to its terminal by incarnation, `{terminalId, spawnedAt}`, as session records are. It takes the first incarnation its reserved terminal spawns, held in memory as well as on the record, so a write that failed can't let a later incarnation take the run. A restart under the same id, or a pty-host crash replaying the spawn, is another incarnation, and its facts aren't the run's. A reserved terminal id belongs to one run: registering another run under it is refused.

The host stamps `spawnedAt` on its spawn result and on the exit. `PtyClient` emits a main-only `incarnation-exit` for every incarnation, including one a same-id respawn replaced: main drops that one's public `exit`, and the host, which keeps nothing for a replaced terminal, sends it as a `superseded-exit` carrying the facts alone. When a pty-host dies and its terminals are replayed, `PtyClient` emits `incarnation-lost` with each old generation.

| Fact | Recorded as |
| --- | --- |
| The spawn succeeded | `terminalSpawnedAt`, and `process.pty` running |
| The spawn failed | settled on `launch-error` |
| The PTY exited | `process.pty` exited with its code and signal; settles an open run on `exit` |
| `incarnation-lost`: the run's incarnation died with its pty-host | `process.pty` exited with no code or signal; settles an open run as `lost` |
| `agent-session:captured` for the incarnation | `resume.agentSessionId`, when it has none yet; settled or not |
| `agent:run-handback-observed` for the run's launch code and incarnation | settles an open run on `handback`, with its report and summary (see Handing back) |

An exit can reach the history before its spawn answer does; the run then takes that incarnation from the exit, and the late answer changes nothing. A run settled before its spawn answered (a cancel, say) still records its process. A captured id never replaces one already there, and a capture for another agent or project is ignored. The agent axis (`process.agent`) has no producer yet: today's agent-exit observation is a heuristic, which never settles a run.

### Quitting and crashing

A quit kills every terminal, and those exits are the quit's, not the run's: while Daintree is quitting, an exit lands on `process.pty` and the run stays open. At the next startup every run still open is settled as `interrupted`, and a process last seen running is marked exited with no code or signal, at the time the startup found it gone. A crash leaves the same state and reaches the same end. A pty-host crash while Daintree keeps running loses the run's incarnation, so the run settles `lost`; the replay that follows is another incarnation, and whether a run's terminal is replayed at all is the launcher's (#15978) to decide.

### Retention and deletion

Each schedule keeps its newest 100 runs, newest by registration time. A run that is still open, or whose process was last seen running, is never pruned: a fact still due for it would have nowhere to land. It goes once it's over and the next prune runs. Pruning a run also drops its occurrence key's protection, so an occurrence that old is kept from running again by the scheduler's evaluation point (#15979), not by the history.

Deleting a schedule deletes its history with it: `ScheduleStore.remove` calls `deleteForSchedule` in the schedule's turn, once the removal is committed. A history that couldn't be deleted is logged and leaves the removal standing. Removing a project removes its runs in the same transaction as its row. A fact that arrives later for a deleted run finds no row and records nothing. A deleted run never ends, open or not, so each deletion is announced instead: `scheduled-runs:deleted` names the project, and the schedule unless the whole project went. The run's process isn't touched.

### Reading it and following it

| Surface | What |
| --- | --- |
| `window.electron.scheduledRuns.listByProject({ projectId })` | The project's runs, newest first |
| `window.electron.scheduledRuns.listBySchedule({ scheduleId })` | The schedule's runs, newest first |
| `scheduled-runs:changed` on `events:push` | `{ projectId, scheduleIds }` after a committed change, sent only to views of the project; a view reads the runs again |
| `scheduled-run:started` on the main event bus | A run was registered to launch, just before its terminal spawns |
| `scheduled-run:ended` on the main event bus | A run settled, once, with its outcome. A run that starts ends, at the next startup if Daintree quits first, or is deleted; a skipped run neither starts nor ends |
| `scheduled-runs:deleted` on the main event bus | `{ projectId, scheduleId }` once a schedule's history is deleted, or `scheduleId: null` once a project's is; its runs will never end |

The IPC surface is read-only: main registers runs and records their facts, so no view can write one.

## Provenance

A terminal launched for a scheduled run carries `spawnedBy: "schedule"` and `scheduledRun: { scheduleId, runId }` (`ScheduledRunRef`, in `shared/types/panel.ts`). The two travel as a pair: `readSpawnProvenance` drops a schedule source whose reference doesn't read, and a reference beside any other source, wherever a terminal is read back. Losing the attribution never costs the pane.

| Where | What carries it |
| --- | --- |
| Live pane | `PtyPanelData.spawnedBy` and `scheduledRun`, kept by restarts (a view's, and main's with no view), CLI-gate relaunches, held-pane recovery and a worktree-delete rollback |
| Saved snapshot | `PanelSnapshot.spawnedBy` and `scheduledRun`, written by `serializePtyPanel` and restored by every hydration builder |
| PTY host | `scheduledRun` on the spawn options and the terminal record, reported back in its terminal info |
| Session record | `AgentSessionRecord.scheduledRun`, stamped by every capture (agent exit, kill, bookmark, quit, project close, trash expiry, Canopy's host-side end) through `scheduledRunForRecord`. A capture of an agent the user started by hand in the pane doesn't take it, even the same CLI once the run's own has exited (`agentIncarnation` past 0). When a run's conversation is resumed in another pane and journaled again, the record keeps the run, as it keeps a bookmark |

Only Daintree's scheduler can set it, by one of two entries, and neither reads it from action arguments:

- **A window driving the project**: `ActionService.dispatch("agent.launch", args, { scheduledRun })`. The dispatch option is stamped onto `ActionContext.scheduledRun`, never from a `contextOverride`, and `agent.launch` hands it to the launcher. The MCP and plugin bridges build their own dispatch options and never set it.
- **Main with no view**: `runAgentLaunch(request, project, deps, { scheduledRun })`. The generic viewless executor, which serves MCP, never passes the fourth argument.

`agent.launch` and the other spawn actions validate `spawnedBy` against `TerminalSpawnSourceSchema`, which leaves `"schedule"` out, so an MCP or plugin caller can't claim it in arguments either. A terminal launched any other way carries no `scheduledRun`.

## Launching a run

`launchScheduledRun` (#15978) launches a schedule's agent as an ordinary agent terminal of its project: the schedule's agent, its preset (`null` is none, never the agent's default), its prompt as written followed by a scheduled run's handback instruction (`handback: true`; see Handing back), and its worktree (`null` is the main checkout), in the grid without taking focus. The prompt reaches the agent as its launch argument, one argv token like every launch prompt, so its line breaks arrive as spaces; the pane's first-prompt record keeps it as written. Every trigger goes through it: Run now today, the scheduler (#15979) with its own origins.

- **Where it launches.** In the local view showing the project, preferring the view that asked: main sends it `schedules:launch-request` and the view dispatches `agent.launch` with the run as host-stamped provenance (`source: "agent"`, `confirmed: true`, so it never becomes the action Repeat Last replays), so the pane appears in that window's grid at once and that view's persistence saves it. A cached view is thawed first, never shown. With no local view, main runs `runAgentLaunch`, which records the pane in the saved layout for the next window that opens the project. A project driven only from another machine's Shell launches in main; that Shell sees the pane when it next reads the project.
- **Registered at the spawn.** The launcher reserves the run's id and terminal id, then asks for the launch. The terminal spawn handler calls `admitScheduledSpawn` immediately before it starts the PTY, with no await between: the first spawn naming a reserved run registers it from the values the terminal actually starts with (cwd after any fallback, the worktree it kept, flags, model, preset, and Claude's assigned session id), so the resume snapshot is what ran. A later spawn naming the run (a restart, held-pane recovery, a crash replay) finds no reservation and spawns as any pane does, so a crash replay re-runs the launch as it does for every agent pane, as another incarnation that isn't the run's.
- **What it refuses.** A spawn that fell back from the schedule's preset, lost its worktree, would start anywhere but the worktree's folder (or the project's, with no worktree), fell back from a working directory that's gone, or reached a project that is going to sleep is refused at the spawn. Before anything launches, a project whose folder is missing or that is going to sleep is refused. A launch that declined (panel limit, an agent CLI that can't start, presets that couldn't be read, another launch of the agent still starting) or failed (an unknown worktree or agent) is recorded through `registerRefusedLaunch` with the reason. A view's own launcher declines a scheduled run whose CLI can't start rather than opening its setup pane, as main does.
- **Waiting.** A view answers once its pane is committed, which can be before the spawn reaches main, so a launch that answered to have started waits up to a minute for its spawn. A view that closes or doesn't answer in a minute, main's own launch not finishing in a minute, or a spawn that never comes, gives the reservation up and records the run as failed; the run's first late spawn is then refused, for the life of the process, so no agent runs behind a failed record. Only the first: the user restarting that pane by hand still gets a terminal. A spawn the PTY host refuses as it is sent settles the run as failed at once, and Run now answers `failed`.
- **Removal.** The reservation is made in the turn the schedule was read. Removing the schedule or its project cancels a reservation still waiting to spawn, synchronously with the removal, and refuses its spawn. A launch already refused but not yet recorded is marked too, and every launch reads that mark right before it writes, so none writes into a history that went with its schedule: Run now answers `not-found` and nothing is recorded.
- **The history must be able to record it.** With the run history unavailable nothing launches, and Run now answers `failed` with no run id. A schedule, or a project, that is gone answers `not-found`: removing a project removes its schedules and history.
- **Sleep and status.** While a run is reserved or open, automatic sleep (idle auto-close, idle shells, memory pressure) holds the project as a `scheduled-run` coordination hold; a user's Sleep still goes through and the run's terminal exits with it. A run that spawns in a project that read `closed` moves it to `background`, so it doesn't read as closed while the run is in it.

Run now is `window.electron.schedules.runNow(scheduleId)`, sender-scoped like the other schedule channels, answering `ScheduleRunNowOutcome`: `started` with the run and terminal ids, `failed` with the reason and the failed run's id, or `not-found`. It runs whether or not the schedule is enabled. The `schedules.runNow` action calls it; it is on no MCP tier, hidden from `tools/list`, and closed to plugins, which may give an agent a task but not launch one with a schedule's preset.

## Handing back

An interactive agent doesn't exit when it finishes, so the run asks it to say so (#15982). Its launch prompt ends with the run's handback instruction (`HANDBACK_RUN_INSTRUCTION_TEMPLATE`), which offers two lines, each with a one-line summary: `DAINTREE-DONE-<code>: <summary> END-<code>` when the work is done, and `DAINTREE-NEEDS-YOU-<code>: <summary> END-<code>` when the user should look. Every other handback request is offered only the first, and is detected exactly as before.

- **Only the run's launch.** `agent.launch` picks the run's instruction when the dispatch carries `scheduledRun` (a view's) or `runAgentLaunch` is given one (main's), both host-stamped, so no argument asks for it. The code is minted there as for any handback launch. The spawn handler hands `admitScheduledSpawn` the code, and only the spawn that registered the run is started with `handbackInstruction: "run"`, so a restart, held-pane recovery or crash replay under the same id never reports for the run (a replay drops the code and the flag with the host that held them).
- **Observed, never inferred.** The pty-host reads either marker for that request with the ordinary detector rules (the echoed instruction, a marker still streaming, one on a spinner's status line, one spanning cut bytes all refused) and sends `agent:run-handback-observed` with the code, the report, the summary as captured, and the incarnation's `spawnedAt`. It sends it for the capture that retires the code, the last look every handback request gets: a marker seen in the output while the agent doesn't read as working, or found at the agent's settle out of working. A marker drafted mid-reply (a thinking preview, a status line) is observed as any handback is but is no report until then, so a close policy never ends a reply still printing. Agent state only decides which printed marker is the final one; it never stands in for a marker, and no state settles a run. In view at once, the latest complete marker is the report, since the instruction asks for it to end the message. A marker for a later prompt's code is no report of the run's. The event is main-only and not buffered for the event inspector, because the summary is terminal text.
- **The first report settles.** The recorder takes a report only for the code the run registered with and only from the run's own incarnation (a report can beat its spawn answer, and then claims the incarnation as an exit can), and settles an open run on `{ kind: "handback", report, summary, truncated }`. Settlement never changes, so a later marker, of either form, records nothing. A run whose agent never reports stays open until its process exits, its terminal is lost, or Daintree quits; nothing settles it from what the agent seems to be doing.
- **The summary is a claim.** It is what the agent wrote between the markers, rows rejoined and capped at 500 characters (`truncated` when cut), null when empty. Nothing checks it.

### The done policy

A run handed back as `done` applies its schedule's `onDone`, as the launch read it: editing the schedule changes later runs. `needs-you` leaves the terminal where it is, whatever the policy, and so does every other settlement, an exit with code 0 included: only the agent's own report says the work is finished.

| `onDone` | A local view shows the project | No local view |
| --- | --- | --- |
| `keep` | Nothing moves | Nothing moves |
| `background` | Each view moves the run's pane to the background (`backgroundTerminal`), and Main parks it in the saved layout | Main parks it in the saved layout (`backgroundViewlessTerminal`), restoring to where it was |
| `close` | Main closes the terminal, then each view removes the pane (`removePanel` with the backend already closed) and Main takes it out of the saved layout | Main closes the terminal, then takes the pane out of the saved layout (`forgetViewlessTerminal`) |

- **Closing keeps the session.** Main closes the terminal the way a quit does, with a graceful kill that asks the agent to leave and captures its session id, and emits `agent-session:captured` with boundary `kill`: the journal keeps the session for resuming and the run records it as `resume.agentSessionId`. It never goes through the trash a view's close uses. Main closes only the run's own incarnation: the host's answer must name the run's `spawnedAt` and the launch generation main last minted for the id, checked with no await before the kill is sent, so a restart asked for meanwhile is left alone.
- **Views own their panes.** Main asks every local view of the project, cached ones thawed first, over `schedules:finish-request`; a view acts only on a pane whose `scheduledRun` is that run, and leaves one the user already took out of the grid and dock. Main writes the saved layout as well, since a view that opened while main was launching the run may hold no pane for it; a view that does saves the same placement from its own store. A project driven only from another machine's Shell is out of scope, as Remote Hosts are.
- **After the launch.** The policy is armed once the launch has finished, its pane committed and saved, so moving the pane can't race the launch writing it; a run that handed back before then is acted on as it is armed. A run deleted with its schedule or project is forgotten. Nothing moves while Daintree is quitting.
- The pane axis isn't written yet: with no producer for `open`, recording only the policy's moves would mislead.

## Keeping the machine awake

An unattended run needs the display awake as well as the system: a run under `caffeinate -is` alone froze when the display slept. `PowerSaveBlockerService` holds a `prevent-display-sleep` blocker from `scheduled-run:started` until the run's `scheduled-run:ended` or a `scheduled-runs:deleted` that covers it, and on quit, when the service is disposed. Electron merges every blocker into one wake lock of the strongest type, and Chromium's display lock also holds off idle system sleep on macOS, Windows and Linux. It doesn't override a closed lid or another forced sleep.

- Runs share the one blocker, released after the last one ends.
- It follows the keep-awake setting and the battery rule (`isAllowedByPolicy`), and comes back when they allow it with no run event needed.
- It ends on facts alone, so it runs on no budget: the agents' heuristic hold keeps its own `prevent-app-suspension` blocker and renewal budget, and either can be released without touching the other.
- The recorder's start callback builds the service before the event goes out, so a run launched before any window has a listener.
- `KeepAwakeState` carries `isDisplayBlocking` and `scheduledRunIds`; the diagnostics snapshot's `keepAwake` section adds the working agent and attached frontend counts, and never builds the service. The `[PowerSaveBlocker]` log lines name each run.

## Who writes what

| Child | Owns |
| --- | --- |
| #15975 | Storing schedules in local per-project data, and their IPC |
| #15976 | Durable run history: registration before spawn, exit and session capture |
| #15977 | Schedule provenance on terminals, snapshots and session records (see Provenance) |
| #15978 | Launching a schedule's agent as a tracked run (Run now) |
| #15979 | Firing due schedules across sleep, wake, restarts and clock changes; catch-up windows |
| #15980 | The overlap policy and the precondition command |
| #15981 | Holding the machine and display awake for a run |
| #15982 | The done and needs-you handback, and the done policy |
| #15984, #15985 | The Schedules view and the cadence picker |
| #15989-#15993 | Windowless launch and the per-platform OS jobs |
