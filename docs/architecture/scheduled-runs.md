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
| The schedule mark on a run's pane and resume rows, and the names they show | `src/components/Terminal/TerminalScheduleChip.tsx`, `src/components/Terminal/ResumeSessionsPalette.tsx`, `src/store/scheduleNamesStore.ts` |
| A cadence in words | `shared/utils/cronDescription.ts` |
| The cadence picker, and reading an expression as a picker state | `src/components/Schedules/CadencePicker.tsx`, `src/components/Schedules/cadenceChoice.ts` |
| The Schedules view and the `schedules.open` action | `src/components/Schedules/`, `src/services/actions/definitions/scheduleActions.ts` |
| Launching a run, routing it to a view or main, refusals | `electron/services/scheduledRuns/ScheduledRunLauncher.ts`, `scheduledRunLaunchLive.ts`, `scheduledRunViewBridge.ts`, `src/hooks/useScheduledRunLaunchBridge.ts` |
| Registering a run at its terminal's spawn | `electron/services/scheduledRuns/scheduledRunAdmission.ts`, called from `electron/ipc/handlers/terminal/lifecycle.ts` |
| Run now (`window.electron.schedules.runNow`, `schedules.runNow`) | `electron/ipc/handlers/schedules.ts`, `src/services/actions/definitions/scheduleActions.ts` |
| The run's handback instruction and its markers | `shared/types/handback.ts`, `shared/utils/handback.ts`, `electron/services/pty/HandbackDetector.ts`, `electron/services/pty/runHandback.ts` |
| The done policy | `electron/services/scheduledRuns/ScheduledRunDonePolicy.ts`, `scheduledRunDonePolicyLive.ts`, `src/hooks/useScheduledRunFinishBridge.ts` |
| The overlap policy and the precondition | `electron/services/scheduledRuns/ScheduledRunLauncher.ts`, `scheduledRunPrecondition.ts`, `ScheduledRunRecorder.beginReplacement` |
| Run now's overlap confirmation | `src/store/scheduleRunConfirmStore.ts`, `src/components/Schedules/ScheduleRunConfirmDialog.tsx` |
| Firing due schedules: evaluation points, the clock, power events, catch-up | `electron/services/scheduledRuns/ScheduledRunScheduler.ts`, `scheduledRunSchedulerLive.ts` |
| Notifying when a run needs you, and where its click lands | `electron/services/scheduledRuns/scheduledRunAttention.ts`, `scheduledRunNotifierLive.ts`, `electron/window/scheduledRunNotificationNavigation.ts`, `src/services/scheduledRunLanding.ts` |
| The OS job's launch: the `--run-due-schedules` flag, the windowless start, the first window | `electron/boot/dueScheduleLaunch.ts`, `electron/lifecycle/appLifecycle.ts`, `electron/lifecycle/initialWindowRequest.ts`, `electron/main.ts` |

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
- **A schedule's page** is its run history (#15986), newest first and grouped by day in the schedule's zone, read by `listBySchedule` and again on each `scheduled-runs:changed` naming the schedule. Each run shows its outcome (read from the evidence, with its glyph), the agent's handback summary (attributed to the agent) or the recorded reason (a skip's cause, a launch error, an interruption), when it started against when it was due, its trigger, and how long it took to settle (elapsed so far while it's open; none for a run that never started or was interrupted). **Open** shows on a run whose terminal was seen to start and still has a pane in this view, trashed or backgrounded included, and brings it forward in its worktree once the dialog has closed. **Resume** shows once the pane is gone and the resume snapshot has a session id, and reopens the conversation through the same policy as every human resume surface (`resumeSessionForPerson`), in the run's recorded worktree and cwd. Otherwise the row says why: it never started, no session was saved, its worktree is gone, or its agent can't resume. **Run now** sits in the page's header; a refusal the history recorded is its newest run, and only a failure it couldn't record is shown on the page with Retry. Changes are announced in one status line, never by making the list live, and runs that arrive while the pointer or focus is in the history wait behind "Show N new runs" rather than moving the rows.
- **Editing** is a page of its own, reached from the schedule's page by **Edit schedule**: name, agent, preset, worktree and prompt; the cadence, missed runs and overlap; the precondition and the done policy. It saves explicitly, because a half-typed prompt or cron must never be committed for an unattended run; Save, Cancel and Back return to the schedule's page; leaving with unsaved edits asks first, and an edit made from an older version is refused as a conflict with a way to load the latest. A new schedule takes `createSchedule`'s defaults.
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
| `os-launch` | Found by the first pass of a Daintree an OS job started windowless | the occurrence | when it also catches up |
| `run-now` | The user asked for it | `null` | `null` |

The occurrence key is `occurrenceKeyFor(dueAt)`, the due instant in UTC ISO form, and is unique per schedule: a restart can't run the same occurrence twice. The two showings of a repeated wall clock are different instants, so they'd have different keys, though the cadence only ever produces the first. `coalesced` is the window `(after, through]` a late run stands for, with `dueAt` the latest occurrence inside it, so a long sleep produces one record rather than one per missed occurrence. Under `missedRuns: "skip"` the same record is settled as skipped with reason `missed`. Registering a run and advancing the schedule's evaluation point commit together (see Firing due schedules), or a rolled-back point could replay an older occurrence inside an already-consumed window.

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
- Each of these, for a run with an occurrence, moves its schedule's evaluation point up to the run's `coalesced.through`, or its `dueAt` without one, in the same transaction as the run's row. Run-now runs leave it alone.
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

Each schedule keeps its newest 100 runs, newest by registration time. A run that is still open, or whose process was last seen running, is never pruned: a fact still due for it would have nowhere to land. It goes once it's over and the next prune runs. Pruning a run also drops its occurrence key's protection, so an occurrence that old is kept from running again by the schedule's evaluation point, not by the history: `schedule_evaluation_points` (migration 0021) keeps it when the run behind it goes.

Deleting a schedule deletes its history and its evaluation point with it: `ScheduleStore.remove` calls `deleteForSchedule` in the schedule's turn, once the removal is committed. A history that couldn't be deleted is logged and leaves the removal standing. Removing a project removes its runs and evaluation points in the same transaction as its row. A fact that arrives later for a deleted run finds no row and records nothing. A deleted run never ends, open or not, so each deletion is announced instead: `scheduled-runs:deleted` names the project, and the schedule unless the whole project went. The run's process isn't touched.

### Reading it and following it

| Surface | What |
| --- | --- |
| `window.electron.scheduledRuns.listByProject({ projectId })` | The project's runs, newest first |
| `window.electron.scheduledRuns.listBySchedule({ scheduleId })` | The schedule's runs, newest first |
| `scheduled-runs:changed` on `events:push` | `{ projectId, scheduleIds }` after a committed change, sent only to views of the project; a view reads the runs again |
| `scheduled-run:started` on the main event bus | A run was registered to launch, just before its terminal spawns |
| `scheduled-run:ended` on the main event bus | A run settled, once, with its outcome. A run that starts ends, at the next startup if Daintree quits first, or is deleted; a skipped run neither starts nor ends |
| `scheduled-runs:deleted` on the main event bus | `{ projectId, scheduleId }` once a schedule's history is deleted, or `scheduleId: null` once a project's is; its runs will never end |
| The recorder's `onRunSettled` | Every committed settlement once, with the whole record: each run that ends, and the skipped and refused runs that neither start nor end. The record holds the agent's summary, so it stays in main and is never put on the bus |

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

### Where it shows

A scheduled run's pane header carries the schedule mark (`CalendarClock`) and the schedule's current name after its title, or after the tab strip for a tab group's active pane (#15987). Activating it dispatches `schedules.open` at that schedule's page. The resume palette's rows for a scheduled session carry the same mark and name after the location, and the name is searchable. The names come from one shared read of the view's schedules (`scheduleNamesStore`), held only while a scheduled pane or palette row is shown, so a view with no scheduled runs reads nothing. A schedule the read doesn't contain shows as "Deleted schedule"; one not read yet, or whose read failed, as "Scheduled run". A window driving a Remote Host reads nothing, and its mark is a plain label.

## Launching a run

`launchScheduledRun` (#15978) launches a schedule's agent as an ordinary agent terminal of its project: the schedule's agent, its preset (`null` is none, never the agent's default), its prompt as written followed by a scheduled run's handback instruction (`handback: true`; see Handing back), and its worktree (`null` is the main checkout), in the grid without taking focus. The prompt reaches the agent as its launch argument, one argv token like every launch prompt, so its line breaks arrive as spaces; the pane's first-prompt record keeps it as written. Every trigger goes through it: Run now, and the scheduler with `scheduled`, `catch-up` and `os-launch` origins. A schedule switched off after the scheduler read it fires nothing: the launcher, reading it again, answers `not-found` for any origin but `run-now` and records nothing.

- **Where it launches.** In the local view showing the project, preferring the view that asked: main sends it `schedules:launch-request` and the view dispatches `agent.launch` with the run as host-stamped provenance (`source: "agent"`, `confirmed: true`, so it never becomes the action Repeat Last replays), so the pane appears in that window's grid at once and that view's persistence saves it. A cached view is thawed first, never shown. With no local view, main runs `runAgentLaunch`, which records the pane in the saved layout for the next window that opens the project. A project driven only from another machine's Shell launches in main; that Shell sees the pane when it next reads the project.
- **Registered at the spawn.** The launcher reserves the run's id and terminal id, then asks for the launch. The terminal spawn handler calls `admitScheduledSpawn` immediately before it starts the PTY, with no await between: the first spawn naming a reserved run registers it from the values the terminal actually starts with (cwd after any fallback, the worktree it kept, flags, model, preset, and Claude's assigned session id), so the resume snapshot is what ran. A later spawn naming the run (a restart, held-pane recovery, a crash replay) finds no reservation and spawns as any pane does, so a crash replay re-runs the launch as it does for every agent pane, as another incarnation that isn't the run's.
- **What it refuses.** A spawn that fell back from the schedule's preset, lost its worktree, would start anywhere but the worktree's folder (or the project's, with no worktree), fell back from a working directory that's gone, or reached a project that is going to sleep is refused at the spawn. Before anything launches, a project whose folder is missing or that is going to sleep is refused. A launch that declined (panel limit, an agent CLI that can't start, presets that couldn't be read, another launch of the agent still starting) or failed (an unknown worktree or agent) is recorded through `registerRefusedLaunch` with the reason. A view's own launcher declines a scheduled run whose CLI can't start rather than opening its setup pane, as main does.
- **Waiting.** A view still loading is asked once its state has hydrated (`session-restore:view-hydrated`, latched in `electron/window/viewHydration.ts`), when its bridge listens: preload buffers no push, so one sent earlier is lost. A view restored in the background and never painted reports it too, unlike `app:first-interactive`. A view answers once its pane is committed, which can be before the spawn reaches main, so a launch that answered to have started waits up to a minute for its spawn. A view that closes or doesn't answer in a minute, main's own launch not finishing in a minute, or a spawn that never comes, gives the reservation up and records the run as failed; the run's first late spawn is then refused, for the life of the process, so no agent runs behind a failed record. Only the first: the user restarting that pane by hand still gets a terminal. A spawn the PTY host refuses as it is sent settles the run as failed at once, and Run now answers `failed`.
- **Removal.** The reservation is made in the turn the schedule was read. Removing the schedule or its project cancels a reservation still waiting to spawn, synchronously with the removal, and refuses its spawn. A launch already refused but not yet recorded is marked too, and every launch reads that mark right before it writes, so none writes into a history that went with its schedule: Run now answers `not-found` and nothing is recorded.
- **The history must be able to record it.** With the run history unavailable nothing launches, and Run now answers `failed` with no run id. A schedule, or a project, that is gone answers `not-found`: removing a project removes its schedules and history.
- **Sleep and status.** While a run is reserved or open, automatic sleep (idle auto-close, idle shells, memory pressure) holds the project as a `scheduled-run` coordination hold; a user's Sleep still goes through and the run's terminal exits with it. A run that spawns in a project that read `closed` moves it to `background`, so it doesn't read as closed while the run is in it.

Run now is `window.electron.schedules.runNow(scheduleId, options?)`, sender-scoped like the other schedule channels, answering `ScheduleRunNowOutcome`: `started` with the run and terminal ids, `skipped` with the run id and its skip reason, `confirm-overlap` (below), `failed` with the reason and the failed run's id, or `not-found`. It runs whether or not the schedule is enabled. The `schedules.runNow` action calls it; it is on no MCP tier, hidden from `tools/list`, and closed to plugins, which may give an agent a task but not launch one with a schedule's preset. It is `danger: "confirm"` because it can ask before running alongside or replacing open runs.

## Overlap and precondition

Every launch meets the schedule's overlap policy and then its precondition (#15980), inside `launchScheduledRun`, so Run now and the scheduler's triggers are judged alike.

- **One launch of a schedule at a time.** Each launch takes a per-schedule turn from reading the schedule to its outcome, so two triggers arriving together (a catch-up and a Run now) can't both find no open run: the second is judged against the run the first left. Different schedules don't wait on each other.
- **An occurrence already recorded does nothing.** A trigger naming an occurrence the history already holds answers `already-recorded` before any precondition runs or any run is closed.
- **Open means unsettled.** Overlap reads the settlement axis, a fact: a run is open until its exit, a handback or another settlement says otherwise. A run settled on a handback whose terminal the done policy kept doesn't hold the next one back.
- **Skip** (the default) records the occurrence as skipped with `{ kind: "overlap", openRunId }`, naming the newest open run, and runs nothing, not even the precondition.
- **Start another** goes ahead beside the open runs.
- **Replace** runs the precondition first, and only once it passes closes every open run: the terminal goes the way a graceful quit closes one, through the `terminal:graceful-kill` handler (the agent asked to quit, its session captured and journaled), and its pane leaves the saved layout and every local view showing the project (`schedules:run-closed`). A terminal restarted since the run's incarnation is the user's: it isn't closed, and its pane stays. While it closes, `beginReplacement` holds back the settlement its own exit or loss would make; once the PTY is seen gone the run settles as `replace` naming the new run, and a session id the close captured fills its resume snapshot. A close that fails, a PTY not gone within 10 seconds, or a replacement the history couldn't record launches nothing: the run is left as its own facts say, and the new one is recorded as failed. Replacing stops at the first run that won't close. Closing is the commit point, so a replacement whose new run then fails to launch still names it.
- **Run now asks.** With open runs under `skip` or `replace`, Run now records nothing and answers `confirm-overlap` with the policy, the open run ids and the schedule's name. The action asks the user (`ScheduleRunConfirmDialog`: "Start another run" alongside, or "Replace run"), and the answer goes back as `options.overlap` with the runs it named. Main checks again in a new turn: a run opened since, or a changed policy, is asked about again. Backing out runs and records nothing. Under `start-another` it never asks.

The precondition runs in the schedule's worktree (or the project's folder), never in a fallback: a folder that's gone refuses the launch first. It runs in the user's shell, a login shell for zsh and bash but never an interactive one (nobody is at a prompt, and an interactive shell ignores a timeout's SIGTERM), PowerShell or cmd on Windows as a command launch runs them, with the environment a project command gets (the install allowlist, the SSH agent socket, the user's global and project variables, Daintree's own namespace removed, non-interactive markers set). Its output is discarded, and neither the command nor its output is logged.

| Precondition | Outcome |
| --- | --- |
| Exit 0 | The run goes ahead |
| Any other exit code | Skipped, `{ exitCode }` |
| Ended by a signal | Skipped, `{ signal }` |
| Still running after 60 seconds | Its process tree is killed, and it is skipped with `error` saying it timed out |
| Couldn't start | Skipped, with the `error` |

The run's id and terminal id are reserved before the precondition runs, so a skipped run keeps the reserved terminal id, removing the schedule or project stops the check and records nothing, and automatic sleep holds the project meanwhile. Quitting kills every precondition still running (`disposeSchedulePreconditions`). Run now meets the precondition too: a schedule is run as it would run.

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

## Firing due schedules

`ScheduledRunScheduler` (#15979) fires every enabled schedule of every local project while Daintree runs, with or without a window: the windowed boot and the windowless boot (Host mode's, or an OS job's) start it from the deferred queue (`scheduled-run-scheduler`), and it launches through `launchScheduledRun`, which picks a view or main. It holds each project's schedules from `ScheduleStore.list` and follows `subscribe`, keeping the newer snapshot by revision, so a slow first read can't put back what a removal took away. Until a schedule is enabled it keeps no timer and doesn't open the run history.

- **Where a schedule stands.** Its evaluation point is the latest occurrence a run of it was registered for, kept in `schedule_evaluation_points` beside the history and moved only by a registration (above). A schedule is evaluated from that point, or from its timing floor when that's later, and nothing before the floor counts as missed: the moment it was switched on or its cadence changed while Daintree ran, or its `updatedAt` as read at startup. Switching a schedule back on doesn't catch up the time it was off, and an edit to anything else while Daintree runs keeps the window it had. A schedule with no point starts from its floor.
- **Looking at the clock.** Node's timers run on monotonic time, which stops while Linux and Windows sleep, and Electron reports no clock or time-zone change, so the scheduler never waits for a due time with one long timer. It looks at the wall clock at the earliest next due time, or 30 seconds at the longest, and at once on `resume`, `unlock-screen` (raw `powerMonitor` events, not the delayed `sys:wake`) and every committed edit, including a switch-off, which leaves no timer when nothing is enabled. A clock change is seen at the next look, within 30 seconds. Due times are instants in each schedule's own zone, so a change of the machine's zone moves none. On macOS, App Nap can stretch the timers of a Daintree with no visible window and no hold of its own (no working agent, attached Shell or open run); nothing here prevents it.
- **On time.** An occurrence found within a minute of its due time, with none missed before it and the scheduler watching throughout, launches with trigger `scheduled`.
- **Missed.** Anything else found in the window is missed, and the schedule's policy applies to all of it once: one `catch-up` launch, or under `missedRuns: "skip"` one skipped record, with `dueAt` the latest occurrence and `coalesced` the window from the evaluation point through the moment it was found. The scheduler is not watching at startup, after `suspend`, or when the wall clock moved more than 10 seconds apart from monotonic time since its last look (a sleep with no events, or a clock change), so what that pass finds is missed even if it came due seconds before. Nor is it watching a schedule while its launch is in flight, while its project's schedules can't be read, or while it waits out a retry: an occurrence that came due by the time that ended is missed too, and one due after it can still be on time.
- **Once.** An occurrence is consumed only when the history records its run: launched (registered at its terminal's spawn), refused before it spawned, or skipped. A schedule has one launch in flight at a time; occurrences that come due meanwhile are found missed when it finishes. Switching the schedule off cancels its launch still waiting to spawn (`cancelScheduledLaunches` with `automaticOnly`, which leaves Run now's alone), and a quit refuses it; neither records anything, so a quit's occurrence is caught up at the next startup. Once registered, an occurrence never runs again. A launch that recorded nothing or found the schedule gone, a skip that couldn't be written, and a project whose schedules couldn't be read are tried again a minute later, not every look. A skip is never written for a project whose row is gone.
- **Clocks set back.** The point never moves back, so a clock set back waits until it passes the last occurrence that ran. A clock set far ahead and then corrected stalls the schedule until the clock catches up with what ran: the price of never running an occurrence twice once its run is pruned.
- **The first pass.** No pass runs until every project's schedules have been read once, so an early edit or check can't evaluate some projects before the rest and spend the startup pass on them.
- **Shutdown.** Once shutdown has begun no pass launches or records anything, and a launch in flight neither spawns nor records its refusal; `stopScheduledRunScheduler` clears the timer and the power and store listeners before the database closes.

## Notifying when a run needs you

A run that settles needing a person puts up a native notification on this machine (#15988), read from the evidence it settled on (`scheduledRunAttention`):

| Settled on                                | Notifies                              |
| ----------------------------------------- | ------------------------------------- |
| `launch-error`, a refused launch included | "Scheduled run couldn't start"        |
| `exit` with a non-zero code               | "Scheduled run failed", with the code |
| `handback` `needs-you`                    | "Scheduled run needs you"             |
| Anything else                             | Nothing                               |

- **Exits by signal alone stay quiet.** An exit with code 0 and a signal is how Daintree's own kills end a terminal (the trash's expiry, a kill), so it says nothing about the agent's work. A run that went fine, was skipped by its policy, cancelled, replaced, lost or interrupted is in its history and pages nobody.
- **From the commit, not the bus.** The recorder hands every committed settlement to `onRunSettled`, which `getScheduledRunRecorder` installs before any run can register, so a launch refused at once can't outrun it. The delivery is imported only when a run needs attention, and it never holds up or undoes the settlement.
- **Names and codes only.** The banner names the schedule and the run's agent (the schedule's agent for a refused launch, which has no resume snapshot); the agent's summary and a launch error's reason stay in the history the click opens. It names no owning view, so it is shown on this machine and never handed to a remote Shell.
- **The same gates as agent notifications.** It is held back while the project's notifications are off, in quiet hours, or while this machine's session is muted, read again after the schedule is so a mute set meanwhile counts. It plays the waiting sound when sounds are on. A run in a worktree on screen still notifies: what it reports is a recorded outcome, not a wait the user can see.
- **The click.** Main brings the run's project on screen: the window holding it comes forward, or failing that a window on this machine switches to it, as picking it there would, once that window's view (or, in a window showing the project picker, the renderer it started with) has hydrated and can take the request; with none (a windowless Host, or macOS after the last window closed) it opens one on the project through the opener `main.ts` sets (`setScheduledRunWindowOpener`), and any click while that window opens waits for it to hydrate, for two minutes at most, so two clicks never open two windows and one that never comes up holds nothing back. A closed project opens, since the click asked for it; one that is gone or missing on disk opens nothing, and nor does a Host with no display. The view showing the project is sent a `focus-scheduled-run` intent once it has hydrated, and only if it still shows the project then (a cached or activating view gets it through the switch it runs); a window opened for the click is waited on for up to a minute. The view decides from its own panes: the run's pane, trashed or backgrounded included and whatever its terminal did since (a spawn that failed can leave one showing the error), comes forward and takes focus; with none, the schedule's history opens, or the list when the schedule is gone. A Schedules view already open is left as it is: moving it to another page would drop an edit in progress without asking, and a focused pane would sit under the dialog.
- Clicks are routed while Daintree runs: the handler lives in the process that showed the banner, so one clicked after Daintree quit isn't routed to the run.

## Running due schedules from an OS job

An OS job (#15990 on macOS, #15991 on Linux) runs Daintree with `--run-due-schedules` (#15989). It's a switch, so no argv parser reads it as a folder or archive to open.

- **Daintree running.** The second launch hands the flag over and exits. The running Daintree asks its scheduler for a pass at once (`checkDueSchedules`, `ScheduledRunScheduler.check`), and focuses, opens and routes nothing for it, whatever else the launch carries. That Daintree was watching, so the pass follows the usual rules and triggers. Before its scheduler has started there's nothing to do: the startup pass is still to come. This works on every platform.
- **Daintree not running.** On macOS and Linux it starts with no window through the windowless backend boot (`startHostRuntime`), without Host mode: no listener starts for it unless the Host-mode setting is on, as for any launch. It keeps running when it has no window, closing the last window doesn't quit it on Linux, and a relaunch or Dock click before the start settles waits for it. On Windows the windowless start is #15992; until then a cold launch with the flag exits (code 4) rather than open the app.
- **The first pass.** The OS job watched while Daintree wasn't running, so the startup pass doesn't call the occurrence it fired for missed. The launch instant is the process start (`performance.timeOrigin`). An occurrence alone in its window launches on time with trigger `os-launch` and no `coalesced`, under either missed-runs policy, when it came due less than a minute before the launch, or after the launch and was found within a minute as on any pass. Anything else that pass finds is missed and follows the policy once, as at any startup, with trigger `os-launch`: one launch with `coalesced`, or one `missed` skip. The window is never split, so under `missedRuns: "skip"` an on-time occurrence behind older missed ones is skipped with them. A suspend, a resume or a clock jump before that pass makes it an ordinary startup pass; a pass the history wasn't ready for keeps it for the next. Later passes follow the usual rules.
- **The first window.** The windows the launch would have opened wait for the first request to see the app: a Dock click, a relaunch, or a folder opened from outside. That request opens them as a launch would at that moment: the restored fleet, a queued folder's window on the picker, or the recovery window after a crash. Requests while they open join it; later ones open a plain window. The window manifest stays read-only until then, so a quit with no window never overwrites the fleet, and a clean restore makes it writable; a recovery leaves that to the crash restore. A run's terminal is live in its project's view, since the backend the window attaches to is the one that launched it; a project outside the restored fleet shows it when opened.
- **Restarts.** The flag is one-shot: an app-initiated restart (`stripLaunchTargets`) and the reset-data relaunch drop it, so they come back with windows.
- **Display.** A Linux launch needs the user's graphical session, so a window can open later; it never runs Chromium headless, which no window could ever attach to. The timer's environment is #15991's. A losing launch with the flag never offers to take over a headless Host.

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
| #15980 | The overlap policy and the precondition command (see Overlap and precondition) |
| #15981 | Holding the machine and display awake for a run |
| #15982 | The done and needs-you handback, and the done policy |
| #15988 | Notifying when a run fails or needs you, and landing its click |
| #15984, #15985 | The Schedules view and the cadence picker |
| #15989 | The `--run-due-schedules` launch: the check on a running Daintree, the windowless start, and its first pass (see Running due schedules from an OS job) |
| #15990-#15993 | The per-platform OS jobs, and Windows' windowless start |
