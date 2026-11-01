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

- **`settlement`** is `open` until a fact settles it, then `settled` with `settledAt`, an `outcome` and the `evidence`. A settled run never changes. Overlap reads this axis: an open run is an unsettled one, so a kept terminal or a conversation the user carries on doesn't hold the next run back.
- **`process`** holds the agent CLI and the PTY separately, because an agent can exit and leave its shell running. Each is `not-started` (no start seen), `running`, or `exited` with its exit code and signal when known. A signal is a positive number or null; producers map node-pty's 0 to null.
- **`pane`** is `none`, `open`, `background` (moved there by the done policy or the user, not merely out of view), or `closed`.

The outcome follows from the evidence (`outcomeForEvidence`), and the schema refuses a record where it doesn't:

| Evidence                                                              | Outcome              |
| --------------------------------------------------------------------- | -------------------- |
| `handback`: a marker the agent printed, `done` or `needs-you`         | `done` / `needs-you` |
| `exit` of the agent or PTY with code 0 and no signal                  | `done`               |
| `exit` with a non-zero code or a signal                               | `failed`             |
| `exit` with no code or signal known                                   | `exited`             |
| `launch-error`                                                        | `failed`             |
| `skip`, with its reason                                               | `skipped`            |
| `cancel`: the user stopped the run                                    | `cancelled`          |
| `replace`: the overlap policy put `replacedByRunId` in its place      | `replaced`           |
| `lost`: the PTY host confirmed the terminal is gone with no exit seen | `lost`               |

A `needs-you` run is settled: the schedule's attempt is over and its terminal stays for the user. Only `done` applies the done policy. A restart that hasn't yet reconnected to a run's terminal is not `lost`.

Skip reasons are `missed` (only for an occurrence, never `run-now`), `overlap` with the `openRunId` that was still open, and `precondition` with its exit code, signal, or the error that stopped it running (an exit 0 isn't a skip). A skipped run never launches: no pane, neither process started, and no resume snapshot. It may hold a reserved terminal id, since registration can reserve one before the precondition runs.

### Resume snapshot

`resume` mirrors `AgentSessionRecordSchema`: `agentId`, `agentSessionId`, `cwd`, `worktreeId`, `agentLaunchFlags`, `agentModelId` and `agentPresetId`. `agentSessionId` is null until captured, and capture can land after settlement.

## Who writes what

| Child | Owns |
| --- | --- |
| #15975 | Storing schedules in local per-project data, and their IPC |
| #15976 | Durable run history: registration before spawn, exit and session capture |
| #15977 | Schedule provenance on terminals, snapshots and session records |
| #15978 | Launching a schedule's agent as a tracked run (Run now) |
| #15979 | Firing due schedules across sleep, wake, restarts and clock changes; catch-up windows |
| #15980 | The overlap policy and the precondition command |
| #15981 | Holding the machine and display awake for a run |
| #15982 | The done and needs-you handback, and the done policy |
| #15984, #15985 | The Schedules view and the cadence picker |
| #15989-#15993 | Windowless launch and the per-platform OS jobs |
