# Performance Harness

This directory measures what Daintree's performance currently **is**, on each operating system, so that improvements can be found and proven. It is not a gate.

## Measurement, not gating

**The perf suite never fails a run because a number is worse.** Not on a schedule, not anywhere. A run fails only when the measurement apparatus itself is broken:

| Condition                                  | Fails the run? |
| ------------------------------------------ | -------------- |
| A number is worse than its reference value | **No**         |
| A number is worse than yesterday           | **No**         |
| No reference value exists for a scenario   | **No**         |
| A scenario threw                           | Yes            |
| `assertMatrixCoverage` violated            | Yes            |
| An unknown flag, mode or scenario id       | Yes            |
| A metric emitted a non-finite value        | Yes            |
| Results could not be written               | Yes            |
| A configured metric stopped being emitted  | Loud warning   |

This is deliberate, and the reasoning is recorded so nobody re-arms the gate by accident. The gate that existed was providing nothing: it ran on a cron, blocked no pull request, and was red for fifteen consecutive days over ~2% overshoots without anyone noticing. A permanently red suite trains everyone to ignore it. A suite that is always green and always publishes numbers keeps the numbers legible.

**What this costs:** nothing catches a regression automatically. A regression is found when someone next runs a benchmark, or when a user reports it. That is an accepted trade.

**The consequence for anyone reading a run:** green means nothing threw. It is not evidence that the measurement still means anything. A metric that stopped being emitted is reported as a _measurement issue_ and still exits 0 — read that section of the report, not just the exit code.

## Reading a number

Two things decide whether a number can be compared with another number, and `lib/comparability.ts` is the authority on both.

- **Machine-independent** — `count`, `size`, and `ratio`. Compare these freely across machines and operating systems: "Windows 34, macOS 0" is a finding.
- **Machine-dependent** — `duration`, `memory`, `derived-ratio`, and `unknown`. Only meaningful against another run on the _same_ machine. Across two machines the difference is mostly the two machines.

`derived-ratio` is the class worth knowing about, because it is the one that looks portable and is not. A percentage is only machine-independent when both of its terms are: `spawnsPerWorktree` divides two tallies and travels, but `memoryGrowthPct`, `cpuPct` and event-loop utilization divide by the machine's own behaviour. Normalising a runtime number by another runtime number does not remove the machine from the figure, it changes the units it is wrong in. The report marks each number `≡` (compare freely) or `~` (compare only against itself) — two markers, not four, because the question the marker answers is binary.

Counts are also the class that catches the bug latency benchmarks are blind to: a recovery state machine that takes a wrong turn under a transient fault and never returns to the cheap path keeps every individual operation fast. Only a count over a fixed idle window sees it. PERF-105/106 exist for exactly that shape.

**Every count needs a paired correctness reading.** A dead watcher spawns nothing and scores perfectly — it is the best result the harness has ever recorded. So a scenario reporting a count-class metric declares `correctness: [...]` naming its miss counts, and the runner flags any scenario that does not. PERF-105's zero idle spawns is only meaningful beside `detectionMisses: 0`, which proves the edit was still detected.

Two rules make the predicate worth having. Only the first can be checked mechanically:

- **It is emitted on every iteration, including healthy ones, and every sample is zero.** `MetricStat.count` tallies the iterations that emitted a metric, not the run count, so a predicate present in one iteration of fifteen still aggregates to `max: 0` — a clean pass from a scenario that mostly did not run. The runner compares `count` against `runs`, and reads `min` as well as `max`, because several predicates are signed subtractions where a negative means the subject produced more than it was asked to. **Enforced.**
- **It is an independent oracle.** The test to apply is whether a no-op implementation of the subject could satisfy it. A count of its own spawns cannot; a read-back of the state the subject was supposed to produce can. **Not enforced, and not enforceable** — nothing outside the scenario can tell a real oracle from a decorative one that returns 0 unconditionally. This is a review obligation when a predicate is written, and the reason each one names what it actually read.

Every scenario declares a predicate. The exemption list in `__tests__/scenarioMatrix.test.ts` is empty and stays enforced, so a new scenario must either declare `correctness` or be exempted deliberately. The fifteen that once sat on it reported only durations, a `checksum` or retained heap; a checksum nothing compares against an expected value is not an oracle, and the fixtures now report what each subject produced — panels restored, chunks consumed, FSM flips observed, boot marks emitted — for the predicates to read.

The spawn counter validates itself before a scenario trusts it: it confirms its `child_process` hook is still the wrapper it installed, and that starting a real child increments the counter through that hook — reporting `spawnObserverMisses` when either fails. Read that claim narrowly. It proves the funnel is intact, not that the count is complete: the probe cannot see what never reaches the funnel. The counter stays blind to starts made from C++ inside native addons (`@parcel/watcher`'s watchman, better-sqlite3, node-pty), to grandchildren (Windows `exec` → `cmd.exe` → PowerShell), and to `spawnSync`. A zero means "nothing started through Node in this process", never "nothing started". Closing that gap needs an OS-level observer, which this harness does not have.

## Type checking

`scripts/perf` is covered by `tsconfig.perf.json`, wired into `typecheck:projects`, so `npm run typecheck` checks the harness and everything it reaches in `src/` and `electron/`.

It needs its own project because the harness spans both halves of the app. It uses bundler resolution and the renderer path aliases (its relative imports are extensionless or carry `.ts`, which the NodeNext configs would reject), and it leaves `noUncheckedIndexedAccess` off to match `electron/` and `shared/`, which supply most of the transitive graph — turning it on fails ~250 product files their own configs pass.

This closed a real hole rather than a theoretical one. Before it existed, vitest transpiled without checking types, so a rename could silently break a fixture with every test still green: `scenarios/ipc.ts` called a function that had been renamed out from under it, and `lib/worktreeSidebarFixture.ts` called `svc.loadProject(requestId, repoPath)` against a 3-6 argument signature, so `projectId` arrived `undefined` and the fixture measured a load the product never performs. Neither was caught by CI.

## Entry point

Every benchmark runs through one dispatcher, `scripts/perf/index.ts`, exposed as the `perf` npm script. `npm run perf list` prints the full command table; each command spawns its benchmark in its own process, so behavior matches invoking the underlying script directly. Add a benchmark by adding one entry to the `REGISTRY` in `index.ts` — nothing else changes.

```bash
npm run perf list
```

## One scenario at a time

**`--scenario` is required and takes exactly one id. There is no whole-matrix run, and nothing schedules a run at all.** Both are deliberate.

The harness exists for targeted optimisation work, driven a benchmark at a time by `.agents/skills/optimize`. A sweep of 112 scenarios produces a wall of figures nobody reads, while taking the machine away from the one measurement somebody actually wanted — and since nothing gates on these numbers, a sweep has no audience. There is no perf workflow: `performance.yml` is gone, and no cron, no pull request and no branch push runs a benchmark.

Requiring the filter is also what makes results comparable. A scenario measured alone and the same scenario measured beside 111 others ran under different heap, JIT and thermal conditions; `perf compare` refuses a pair whose selections differ, so a matrix run's numbers could never be compared against a targeted one. With the filter mandatory, every result this harness produces is comparable with every other result for that scenario.

```bash
npm run perf smoke -- --scenario PERF-105
```

## Modes

Modes set sampling depth and which scenarios are eligible. Each still needs `--scenario`.

- `smoke`: fast sampling — the one to use while iterating
- `ci`: more iterations (the name is historical; nothing in CI runs it)
- `nightly`: heaviest sampling, plus the packaged-binary scenario
- `soak`: long-run stress focus

A scenario declares which modes it runs in, and an id outside the chosen mode is a usage error — `--mode smoke --scenario PERF-002` fails, because PERF-002 is `ci`/`nightly` only.

## Commands

Every one of these needs `--scenario` with a single id — a bare `npm run perf smoke` exits 1 and tells you so.

```bash
npm run perf smoke -- --scenario PERF-105
npm run perf ci -- --scenario PERF-105
npm run perf nightly -- --scenario PERF-105
npm run perf soak -- --scenario PERF-062
```

### Running one benchmark

The flags that make the local optimisation loop work:

```bash
npm run perf smoke -- --scenario PERF-105 --iterations 5 --label before --json .tmp/opt/before.json
```

| Flag | Effect |
| --- | --- |
| `--scenario <id>` | **Required, exactly one.** Unknown id → error listing the available ones |
| `--iterations <n>` | Overrides the per-tier default for every scenario in the run |
| `--warmups <n>` | Overrides each scenario's own warmup count |
| `--label <name>` | Stamped into the summary — `before`, `after`, `pin-backend` |
| `--json <path>` | Writes the summary somewhere you chose, for `perf compare` |
| `--machine <label>` | Overrides the machine identity (or set `PERF_MACHINE_LABEL`) |
| `--update-baseline` | Merges this scenario's reference into the mode's baseline, re-dating only it |

Argument parsing is strict: an unknown flag, a missing value or a stray positional is an error rather than being ignored. The previous parser silently dropped what it did not recognise, so a typo'd `--secnario` ran the whole matrix and looked like it had worked. Every run ends by printing the exact invocation to reproduce it.

### Comparing two runs

```bash
npm run perf compare .tmp/opt/before.json .tmp/opt/after.json
```

Diffs every scenario and metric into a delta table, leading with the median — at these iteration counts a p95 is effectively one of the two largest samples, not a stable tail estimate.

It **refuses** machine-dependent rows when the two runs are not comparable, and prints `REFUSED` in each affected cell:

- different machine, platform or architecture
- different `--warmups` or `--iterations` (a `--warmups 0` run still carries cold-start cost a warmed run has already paid, and both sides can report the same iteration count, so nothing else would reveal it)
- a summary written before the protocol block existed

Counts still compare through a refusal — that cross-machine comparison is the point. Note the command exits 0 even when it refuses: read the output, not the exit code.

### Results history

Every run that does not override sampling writes `scripts/perf/history/<mode>.<machineLabel>.json` — a small **tracked** file, so `git log -p scripts/perf/history/` answers "when did this get slower" months later. It records p50, p95 and each metric's max, sum and own sample count, and **merges**: a run touches only its own scenario's entry and leaves every other one alone.

A run with `--iterations` or `--warmups` is excluded, because a spot check at three iterations is not comparable with the eight the mode normally takes. The scenario filter is no longer part of that test — every run is filtered now.

## Outputs

Artifacts are written to `.tmp/perf-results/`:

- `*.raw.jsonl` - per-iteration raw samples
- `*.summary.json` - aggregate stats + budget results
- `*.report.md` - human-readable report
- `latest-<mode>.summary.json` / `latest-<mode>.report.md`

The cold recipe fanout benchmark writes its versioned, atomically updated result to `.tmp/perf-results/recipe-fanout.json` by default.

## Control-surface scenarios (PERF-200..205, 220..225, 240..246)

Three families cover the parts of the app every other family runs _through_: the dispatch layer behind menus, keystrokes and MCP tool calls; the plugin system; and the panels that were not already measured. Each drives real product code in a plain Node process, so read the scope limits — none of these has a renderer, and the fixture headers say precisely what that costs.

- **Action dispatch and the MCP tool surface (PERF-200..205)** — the real `ActionService` with all 495 shipped action definitions. PERF-200 times catalog construction and registration; PERF-201 walks the `dispatch()` gate chain through every outcome an MCP call or a keystroke can produce (NOT_FOUND, VALIDATION_ERROR against real zod schemas, DISABLED, CONFIRMATION_REQUIRED, and a success), which costs ~3.4µs; PERF-202 measures the palette's per-context re-projection over the whole catalog; PERF-204 resolves keystrokes against the real 135-binding table including chords. **PERF-203 is the one to watch**: it prices the zod→JSON-Schema compile on first MCP connection and reports the `tools/list` payload per tier — **229 KB at the system tier, 104 KB at workbench, 51 KB external**. Those are deterministic byte counts, so they travel across machines, and they are a public contract with every external agent that connects. No real action's `run()` is entered — the gate chain is the subject, and the bodies need a renderer.
- **The plugin system (PERF-220..225)** — the real `plugin-dev-worker` forked into its own process, and the whole of `PluginService`: scan, the real zod manifest schema, contribution registration, `createHost`, activation. PERF-221 walks 29 manifests and reads the contribution counts back out of the product's own registries rather than out of the scan's self-report, so a loader that registers nothing scores 164 misses. PERF-222 grades 364 capability decisions in **both** directions — allow-everything trips a fail-open counter, deny-everything trips fail-closed — across the static capability check, path containment, and the real JIT consent ladder including a persisted grant. PERF-225 is shaped by the shipped cold-start bug: forge descriptors register eagerly from the manifest while impls bind only in `activate()`, so it asserts zero impls bound before and one after. The product supervisor (`PluginDevWorkerHost`) is deliberately out of the loop; PERF-224 answers how fast a killed worker comes back and whether it serves, not whether Daintree would have restarted it.
- **Panel surfaces (PERF-240..246)** — the file browser, the Review Hub and the file viewer, none of which had coverage. PERF-240/241 build the real tree and scale it, checking the produced row set by symmetric difference against what the fixture actually wrote, so a filter that silently over-hides is caught rather than rewarded. PERF-242 is the one aimed at the known staleness bug: it prices a refresh sweep after a visible write, an ignored-only write and an in-place edit, and requires the new file present and the junk file both absent from rows and counted as hidden. It can prove the sweep accounts for an ignored-only write; it **cannot** prove the sweep was triggered, because that lives in a React hook over a git-derived signal. PERF-244/245 measure Review Hub open across 48 and 423 changed files, where the churn cache is worth ~4,500× warm over cold. PERF-246 reports viewer parse cost, explicitly not first paint.

## Recovery and session scenarios (PERF-260..264, 280..285)

The last two families cover what the rest of the harness explicitly left out. PERF-046 and PERF-224 both measure how fast a killed host comes back and say plainly that the supervisor is not in the loop; PERF-203 measures the MCP tool-surface projection and says plainly that no server is. These close both halves.

- **Supervision and recovery (PERF-260..264)** — the real `WorkspaceHostProcess`, `PtyHostLifecycle`, `PtyClient`, `PluginDevWorkerHost` and `MainProcessWatchdogClient`, driven through their public entry points. The trap this family is built against: **a supervisor that gives up immediately is the fastest supervisor there is**, so `firstCrashMisses` is a policy floor asserted by the probe rather than read from the code — one crash after a healthy start must be survived — and "survived" means the fresh child answered a nonce round trip, not that a `ready` message arrived. PERF-261 deep-compares each of six replayed items against what main cached before the crash, because a host that comes back holding none of its state still serves. PERF-262 grades crash classification against a 12-case spec table in which five cases have a deferred `child-process-gone` reason that disagrees with the exit code, so an exit-code-only classifier — which answers _faster_ — scores misses; one case puts a sibling shard's reason on the bus, which is how a supervisor ends up rewriting one host's verdict with another host's facts. PERF-263 grades the watchdog in both directions on a single run: never firing fails `undetectedFreezeMisses`, firing eagerly fails `spuriousKillMisses` across healthy beats, a suspend, a wake burst and post-kill disarmed ticks. **Backoff is recorded as a schedule, not a latency** — sleeping through a crash ladder measures Node's timer accuracy, so the jitter bounds are recovered by pinning `Math.random` to each end of the range and reading what the product actually scheduled.
- **MCP session and transport (PERF-280..285)** — the real `createSessionServer`, the real SDK on both ends including the client's AJV validation of `structuredContent`, the real `SessionStore`, `GrantCache`, ownership ledger and `AbusePolicy`. **PERF-281 settles what PERF-203's projection number was worth**: on the transport the system tier is 229,321 B against the projection's 229,287 — the entire difference is the 34-byte JSON-RPC result envelope, so the projection figure was the payload almost exactly. Session-ready cost is 231,087 B once the 1,766-byte handshake is counted. PERF-283 grades 109 authorization decisions in both directions across the tier floor, the ownership ledger, the help-session gate, the bound-confirm ceiling and a real `AbusePolicy` driven to a trip, because **a server that authorizes everything is fast and catastrophic**. PERF-285 runs twelve concurrent sessions and treats an external session seeing a workbench tool as a leak.

Both families run in plain Node with Electron stubbed, so neither prices the OS fork, `MessagePortMain`, the real `child-process-gone` vocabulary, or HTTP framing. The fixture headers state the limits in full; the durations are supervisor and handler work, and the counts and byte totals are the readings that travel.

## Theme, notification and registry scenarios (PERF-300..305, 320..325, 340..343, 350..353)

The last three families close the coverage audit. Each is graded against an oracle derived from something the subject does not contain, because the cheap wrong answers here are all fast: a resolver that returns its input, a validator that approves everything, a contrast function returning a constant, a router that notifies nothing, and a router that notifies about everything.

- **Themes (PERF-300..305)** — the real `shared/theme` entry points over all 15 shipped palettes. **The oracles do their own colour maths**, anchored on values that appear nowhere in the subject: WCAG's exact 21:1 for white-on-black, APCA-W3's published 106.04 / −107.88 pair, and the identity that a neutral grey's OKLab L is the cube root of its linearised channel. PERF-300 resolves palette → 155 tokens → 3,111 CSS variables; PERF-301 runs the audit `ThemeBrowser` recomputes on every accent change, with a planted theme whose text sits ~1.01:1 from its own surfaces so the failing direction is exercised on the same pass; PERF-303 grades the import boundary in both directions across 15 valid and 7 deliberately invalid files. **PERF-305 is the one to watch**: `resolveBrandMarkInk` across 18 brand colours × 15 themes × 6 surfaces is 1,620 resolutions at ~72 ms, the heaviest real APCA/OKLCH consumer, and it runs per mark on every theme change.
- **Notifications (PERF-320..325)** — the real `AgentNotificationService` → `NotificationService` path, graded from a table that declares, per transition, both what must fire and what must be suppressed. Every gate in PERF-322's 24-row battery appears twice, once suppressing and once in the configuration where the same signal must get through, so suppress-everything and fail-open are both caught. PERF-323 collapses 91 events into 5 notifications and reads the dedup evidence out of the grouped copy itself ("24 agents waiting for approval"). **PERF-321 found something worth acting on**: per-decision routing cost goes from 12.6 µs at 8 panels to 79 µs at 96 — a ~6× overhead ratio, superlinear in fleet size. Timers run on a virtual clock, so every duration is decision cost with the waiting removed; nothing here measures how long a user waits, and **no OS notification is ever sent**.
- **Forge and the agent roster (PERF-340..343, 350..353)** — the real provider registry, resolver, RPC server and both relays, plus the 18-agent roster. PERF-341's routing table requires 7 of 20 rows to resolve to **nothing**, so a resolver returning the first provider for everything scores 60. PERF-342 grades singleflight with a **signed** counter, so under-coalescing and over-coalescing are distinguishable. PERF-350 grades the roster merge against the filesystem — `shared/config/agents/*.ts` — which a registry cannot satisfy from its own tables. Two findings fell out: `compilePatterns` is not memoized, so 24 panes on one agent recompile the same 26 regexes 24 times (`repeatCompiledPatternCount 624`), and binding a forge impl fires a registry-changed fan-out that re-serializes and re-pushes the entire hostname table even though binding an impl cannot change it.

## Subsystem scenarios (PERF-043..046, 053..058, 074..077, 092..094)

Four families drive the real production subsystem in a real process rather than a stand-in. Each one grew out of replacing a simulation that had drifted from what the code does, so the scope limits below are the point, not boilerplate — several of these measure a floor with a named piece of production deliberately out of frame.

- **Cross-process IPC hosts (PERF-043/044/045/046)** — the actual `workspace-host` and `pty-host` forked into their own processes with `serialization: "advanced"`, so structured-clone cost is real. The host code is real; the transport is Node's `child_process` channel, **not** Electron's — so Electron's pipe, the main-process lifecycle, the renderer MessagePort, crash backoff and state replay are all outside the frame. `lib/ipcFixture.ts` states the limits. PERF-043 times boot-to-ready, proves the host serves a health check, and confirms it exits on a clean dispose. PERF-044 runs 100 correlated round trips and reports messages and serialized bytes each way, with a 64-character nonce per request that must come back intact. PERF-045 streams 2000 indexed lines from one real PTY and prices the parent-IPC **fallback** channel — production's visual path is the renderer MessagePort, which a forked child's channel cannot carry, so this is a volume figure, not the paint path. PERF-046 SIGKILLs the workspace host three times and measures respawn-to-ready; `WorkspaceHostProcess` (crash classification, restart backoff, state replay) is not in the loop, so it answers how fast a killed host comes back, not whether Daintree would have restarted it.
- **Persistence engines (PERF-053..058)** — better-sqlite3 and electron-store at engine level, against a migrated and populated database opened with production's pragmas. PERF-053 contrasts 200 autocommit upserts with the same 200 in one transaction; PERF-054 asserts the query plans so an index that stops being used shows up as a plan change and not just a slower number; PERF-055 adds a concurrent reader, a bounded write-lock contention probe and a TRUNCATE checkpoint; PERF-056 walks the real drizzle migration chain over 4,000 seeded rows so the O(rows) table rewrites are priced. On the JSON side, PERF-057 writes a 400-panel `appState` snapshot and then twelve ordinary settings writes against the now-large file — the whole-file rewrite amplification is the number to read, and it is large. PERF-058 pairs `initializeStore()` through the real corrupt-config preflight with 200 uncached `conf` reads against 200 through the product's cached store proxy.
- **Project view lifecycle (PERF-074/075/076/077)** — a real `ProjectViewManager`, switch controller, eviction controller, lifecycle controller and paint gate, imported unmodified and driven through their public entry points. **Chromium is not real and cannot be** in a plain Node process: `WebContentsView`, `BrowserWindow` and the `electron` module are inert stand-ins, so there is no renderer, no navigation, no paint, no GPU and no RSS. Every headline here is a count or a structural cardinality, and the wall-clock the runner records is harness time, not switch latency — read the counts. The stand-in also decides that every load succeeds, so renderer-side failure modes are not exercised. `lib/projectViewFixture.ts` states the full limits. PERF-074 rotates inside the cache limit and counts warm reactivations against cold starts, checking the wake signal each warm switch must emit. PERF-075 forces an eviction on every switch and validates LRU order and teardown against the manager's own state. PERF-076 drives the graduated pressure ladder and the forced tier-2 reclaim with one view holding an active agent and one a live assistant backend, checking the per-pass budget, the soft agent tier's ordering and the hard assistant floor. PERF-077 queues A-B-C-A-D onto the switch chain in a single tick without draining between them, then reads the settled active view, resident set and window child stack — the manager queues switches and never supersedes one, so this is where that shows.
- **Idle subsystems (PERF-092/093/094)** — the idle-tax counterpart to PERF-105/106, on the process-tree poller instead of the git watcher. The services are real but the process is not the app: CPU here is in-process only, so this is the idle cost of the subsystems, not the idle cost of a packaged Daintree with a renderer and a GPU process attached. PERF-092 idles a real `ProcessTreeCache` with a real subscriber at the pty-host's own 1500ms cadence for 15s, reporting subprocess starts, refresh callbacks, in-process CPU per idle second and event-loop utilization, paired with the discovery latency of a child spawned after the window closes. PERF-093 is the #12042 shape generalised: a PATH shim breaks the `ps`/`powershell` probe for 8s and then heals, and the run reports the cost of idling while broken, the recovery latency, and whether the poller returned to the cheap path over an identical window afterwards. PERF-094 stacks twenty watcher-less `WorktreeMonitor`s — the poll-fallback population beyond the background watcher budget — at the performance profile's 5000ms cadence alongside the process tree, paired with per-monitor poll-tick liveness, a staged file change that must still be detected, and a child that must still be discovered.

## Everyday-interaction scenarios (PERF-190..196)

Three families in the in-process matrix measure interactions a user hits many times a day, driving real production code rather than a simulation. Read each scenario's scope limits below before trusting a delta — PERF-196 in particular measures a parser floor, not wall-clock restore.

- **File picker (PERF-190/191/192)** — the `@`-mention completion and file palette, driven through the real `FileSearchService` against synthetic git repos (~3,200 and ~12,000 files). PERF-192 is the one to watch: it drops the cached path list and times `git ls-files` plus the directory-set build — the wait between pressing `@` and the picker showing anything. That list is rebuilt whenever its 10s TTL lapses and dropped outright when a worktree is created or deleted, so a session pays this repeatedly. Because `FileSearchService` silently falls back to a filesystem walk when git fails, PERF-192 asserts a git subprocess spawned and that the results contain a file only `git ls-files` can return. PERF-190/191 measure the warm per-keystroke re-scan.
- **Terminal search (PERF-193/194)** — find-in-scrollback via the real `@xterm/addon-search` and the app's own `buildSearchOptions`. The search bar debounces at 150ms, so the gated number is a single post-debounce search over a full scrollback, not a per-keystroke cost. The addon memoizes its buffer-to-string translation for 15s and drops it on any line feed, so a terminal still streaming output re-translates on every search where a quiet one does not — worth ~1.3x across the mixed-term sweep, reported per run as `coldToWarmRatio`. PERF-193 gates that cold path, because it is what a live agent terminal actually pays, and reports the warm one alongside. Sizes come from `shared/config/scrollback.ts`, so the benchmark tracks the real configurable range. Fidelity gap (documented in `lib/terminalSearchFixture.ts`): headless has no render service, so decorations are shimmed — the buffer walk, the capped match collection and marker lifecycle are real, the highlight painting is not.
- **Session snapshot/reparse (PERF-195/196)** — `SerializeAddon.serialize()` across a 12-terminal fleet at maximum scrollback (the real teardown cost on every quit), and feeding those payloads back through the xterm parser. PERF-196 is a PARSER FLOOR, not wall-clock restore: production sends payloads this size (~600 KiB) through `TerminalRestoreController`, which chunks at 32 KiB with UI yields and schedules fleet restores independently, and that controller cannot run in-process. A regression in chunking, yielding or scheduling is invisible to PERF-196 and needs a Playwright benchmark. The corpus is SGR-dense because real agent output is, and colour dominates payload size.

Every scenario inherits `maxRegressionPct` from `defaultBudget`. A scenario with no baseline entry is a note, not a problem — normal for a new scenario, and normal for any scenario on a machine or OS being measured for the first time.

The `calibrating` flag is gone. It existed to suppress the regression gate until a runner-generated baseline landed; with no gate left to suppress it did nothing but hide the coverage note for the scenarios it was applied to.

## Reference values

`scripts/perf/config/budgets.json` holds reference values, not thresholds. A measurement outside one is annotated in the report and in the console as `[outside]`, and the run still exits 0. Metric ceilings are compared against each metric's **max** across iterations, never its mean: a ceiling of `gitSpawns: 1.5` must not pass when one iteration in sixteen spawned twenty.

`criticalScenarios` is gone with the gate. It only ever decided which scenarios could fail a run, and while it remained it silently exempted those scenarios from the baseline-coverage note.

## Baselines

Baselines are read from `scripts/perf/config/baseline.<mode>.json` and are the reference the drift annotation compares against.

Regenerate after accepted optimisation work:

```bash
npm run perf smoke -- --scenario PERF-105 --update-baseline
npm run perf ci -- --scenario PERF-105 --update-baseline
```

Baselines are **machine-specific, and that is now the point**. The old rule — regenerate on the runner class, never commit one from a laptop — existed because a baseline was a shared gate, and a laptop number would have become the threshold every platform was judged against. Nothing gates now, and there is no CI to harvest from. A reference value is context for reading one number, so the right reference for your machine is one measured on your machine.

**Every entry carries its own provenance**, because the merge below made a file-wide date a lie:

```json
{
  "generatedAt": "…",
  "mode": "smoke",
  "scenarios": {
    "PERF-105": {
      "p95Ms": 13.4,
      "measuredAt": "…",
      "machine": { "machineLabel": "…", "platform": "darwin", "arch": "arm64" }
    }
  }
}
```

`generatedAt` is now only when the file was last written and dates nothing in it. Freshness is judged per entry against a 30-day threshold and stays advisory: a stale reference for the scenario you are running is named on its own line, the rest collapse into a count.

`--update-baseline` **merges, and re-dates only the scenario it measured**. Every run measures one scenario, so writing the file wholesale would leave a baseline holding a single reference and looking complete — and stamping the whole file with today's date would make forty six-month-old references read as measured this morning. Inherited entries keep their original date and machine, including entries for a scenario that is `diagnostic` or `unsupported` here: regenerating where a scenario cannot be measured must not delete, or re-date, the reference from a platform where it can. The results history under `history/` merges on the same rule.

**A reference from another machine is reported but not compared.** A p95 is a `duration`, so a drift verdict against a number measured on a different laptop is a claim about two laptops. The value is still shown — it is often the only reference a scenario has — and the verdict is replaced with `reference 5.5ms not compared: different machines (greg-thinkpad vs gregs-mac-studio-2)`. Without this guard a Windows reference against a Mac run produced a fabricated 2200% regression.

The four committed baselines are still in the **pre-provenance** shape (`p95ByScenario`, a bare number per scenario). They are read, not migrated: each entry is lifted with the file's own date, which is honest for that shape because the whole-matrix writer that produced it wrote every entry in one pass — and with a **null machine**, which is treated as "measured elsewhere". Unknown resolved in the convenient direction is exactly how another machine's number ends up annotating your run. The practical consequence: **until you re-measure a scenario here, its drift verdict is withheld and the row says why.** One `--update-baseline` for that scenario fixes it and rewrites the file into the new shape.

`npm run perf verify-baselines` asserts the committed files are **usable** — parseable, correctly moded, well-formed entries, provenance complete where present, no zero or non-finite reference (the `durationMs: 0` sentinel trap). It no longer asserts fresh-and-complete, because neither claim has a whole-matrix run behind it any more; coverage, age, machine mix and orphaned ids are reported as notes that cannot fail it. It remains the one script here that exits non-zero.

## Manual cold-start

`npm run perf cold-start` is a manual, one-shot cold-start sampler. It launches the packaged binary N times from a fresh profile, parses the NDJSON marks (`DAINTREE_PERF_METRICS_FILE`) after each run, and prints an aggregated p50/p95 table covering key phase durations, individual marks, and IPC round-trip timings per channel. No thresholds, no baselines, no CI gating.

Requires a packaged binary under `release/` — build one first with `npm run package` (or `npm run package:local` on macOS for an unsigned dev build).

```bash
npm run perf cold-start                   # 5 runs, text table
npm run perf cold-start -- --runs 10      # custom run count
npm run perf cold-start -- --json         # structured JSON for diffing
npm run perf cold-start -- --trace        # capture GPU/compositor traces
```

IPC sampling is forced to 100% for this command so per-channel stats are meaningful across a small number of runs.

The `main_window_shown` mark records the moment `win.show()` is called (when the OS is asked to map the window). It surfaces as the `boot → main_window_shown` and `main_window_created → main_window_shown` phase pairs, exposing the dom-ready-gated window-reveal wait the harness was previously blind to. A mark carries `meta: { fallback: true }` when the 5s dom-ready fallback timer fired instead of the normal dom-ready signal.

## Manual launch A/B (`perf launch-ab`)

`npm run perf launch-ab` is a direct-spawn launch benchmark: it spawns the packaged binary (no Playwright, no debugger attach, no CDP handshake) and reads the app's own NDJSON perf marks, so each sample matches what a user actually experiences. With `--a <exeA> --b <exeB>` it alternates launches between two binaries (A, B, A, B, ...) so machine-state drift lands on both variants equally, then prints per-variant p50/mean/stdDev for the key launch phases plus the delta table. `--warm` gives each variant a persisted profile dir and one unmeasured warmup boot so measured runs are compile-cache/code-cache warm (steady-state boots); the default is a fresh profile per run (first-launch boots).

```bash
npm run perf launch-ab -- --runs 15                       # current release/ build
npm run perf launch-ab -- --a <exeA> --b <exeB> --runs 15 # interleaved A/B
npm run perf launch-ab -- --warm --json ...               # steady-state, machine-readable
```

Prefer this over `perf cold-start` for before/after comparisons across branches: build each branch with `npm run package:local`, move each `release/mac-<arch>` bundle aside, and point `--a`/`--b` at the two executables. (`electron-builder` wipes `release/` on every package run — never leave the only copy of a comparison build there.)

## Keystroke-to-paint and TUI scroll (`perf interactivity`, `perf scroll`)

Two opt-in Playwright benchmarks for the interactions that historically regressed silently — a focused terminal going dead under fleet load, and full-screen TUI scrolling stalling.

`npm run perf interactivity` measures keydown → paint (PERF-120/121/122) across a `cat` floor, a hermetic composer-sim, and the sim under 12 background terminals plus a saturation tier. `npm run perf scroll` measures wheel-notch → paint for mouse-reporting TUIs (PERF-125/126/127), ending in the concurrent cell where six TUIs scroll at once with a bystander keystroke-echo probe.

Both rebuild the e2e bundle, run multi-minute, and gate nothing in CI — they report invariants and ratios, with absolute budgets left until a calibration soak has run. They are opt-in commands, not part of any matrix mode.

```bash
npm run perf interactivity
npm run perf scroll
```

## Cold recipe fanout (`perf recipe-fanout`)

`npm run perf recipe-fanout` rebuilds the E2E benchmark bundle, launches the `full-worktree` Playwright project with one worker, and measures cold PTY fanout at N=1, 5, and 10 for both an existing worktree (PERF-180) and a newly created real worktree (PERF-181). The default fixture is a hermetic `claude` executable placed on a temporary `PATH`; it crosses the normal recipe, panel, PTY host, process, MessagePort, xterm, and DOM-paint paths without using user agent configuration or network access.

```bash
npm run perf recipe-fanout
PERF_RECIPE_FANOUT_SIZES=1,10 PERF_RECIPE_FANOUT_ROUNDS=1 npm run perf recipe-fanout
PERF_RECIPE_FANOUT_OUTPUT=.tmp/perf-results/recipe-fanout-before.json npm run perf recipe-fanout
```

Controls: `PERF_RECIPE_FANOUT_SIZES` (default `1,5,10`, maximum 10), `PERF_RECIPE_FANOUT_ROUNDS` (default `5`), `PERF_RECIPE_FANOUT_WARMUPS` (default `1`), `PERF_RECIPE_FANOUT_AGENT=fixture|vendor` (default `fixture`), `PERF_RECIPE_FANOUT_OUTPUT`, and `PERF_RECIPE_FANOUT_SEED` (default `180`). Vendor mode is diagnostic only and must not be used for regression comparisons because authentication, updates, network latency, and rate limits are not reproducible.

The benchmark has reliability gates but no latency budget: every expected panel, cold PTY spawn, xterm attachment, panel-scoped token paint, worktree assignment, and cleanup must succeed, while timing summaries remain observational until platform baselines are reviewed.

## Bulk issue worktrees (`perf bulk-issue-worktrees`)

`npm run perf bulk-issue-worktrees` measures the full bulk workflow represented by PERF-182: open the forge issue list, select every fixture issue, click Create worktrees, choose a starting-layout recipe, confirm, create one fake worktree per issue, and run the recipe in each worktree. Forge responses, branch/path resolution, and worktree creation are hermetic in-memory IPC handlers, so the benchmark never contacts GitHub or executes `git worktree`; terminal startup continues through the production renderer queue, IPC admission limiter, PTY host, and child-process path.

The default matrix runs N=1, 6, and 10 across three fresh-app rounds with one warmup. Results are written atomically to `.tmp/perf-results/bulk-issue-worktrees.json` and include selection/dialog latency, first and last fake-worktree completion, dialog completion, first and last real terminal spawn, whole-flow latency, renderer frame gaps, terminal-admission pauses, and the number of terminals admitted before the first pause.

```bash
npm run perf bulk-issue-worktrees
PERF_BULK_ISSUE_SCALES=1,10 PERF_BULK_ISSUE_ROUNDS=1 npm run perf bulk-issue-worktrees
PERF_BULK_ISSUE_OUTPUT=.tmp/perf-results/bulk-issue-worktrees-before.json npm run perf bulk-issue-worktrees
```

Controls: `PERF_BULK_ISSUE_SCALES` (default `1,6,10`, maximum 20), `PERF_BULK_ISSUE_ROUNDS` (default `3`), `PERF_BULK_ISSUE_WARMUPS` (default `1`), and `PERF_BULK_ISSUE_OUTPUT`.

## Memory-pressure responsiveness (`perf memory-pressure`)

`npm run perf memory-pressure` builds the E2E benchmark bundle, launches five real PTYs/xterms with seeded scrollback and continuous output, injects a hermetic critical system-memory reading, and measures renderer frame gaps, timer gaps, Long Animation Frames, active-renderer reclaim events, and renderer memory. It is observational rather than CI-gated; use identical controls for before/after comparisons and write each arm to a separate output path.

```bash
PERF_MEMORY_PRESSURE_LABEL=before PERF_MEMORY_PRESSURE_OUTPUT=.tmp/perf-results/memory-pressure-before.json npm run perf memory-pressure
PERF_MEMORY_PRESSURE_LABEL=after PERF_MEMORY_PRESSURE_OUTPUT=.tmp/perf-results/memory-pressure-after.json npm run perf memory-pressure
```

Controls: `PERF_MEMORY_PRESSURE_TERMINALS` (default `5`), `PERF_MEMORY_PRESSURE_SCROLLBACK_LINES` (default `1500`), `PERF_MEMORY_PRESSURE_SAMPLE_MS` (default `12000`), `PERF_MEMORY_PRESSURE_POLL_INTERVAL_MS` (default `1000`, fault-mode only), `PERF_MEMORY_PRESSURE_AVAILABLE_MB` (default `512`, fault-mode only), `PERF_MEMORY_PRESSURE_LABEL`, and `PERF_MEMORY_PRESSURE_OUTPUT`.

## Long-session memory growth (`perf memory-growth`)

`npm run perf memory-growth` builds the E2E benchmark bundle and keeps one Daintree process tree alive while repeatedly switching between two cached projects, streaming output through four stable PTYs/xterms, opening and closing transient terminals, and updating watched files. It seeds each terminal past the analysis and visible scrollback limits before cycle zero, performs warmup cycles, samples both natural and forced-GC retained state, and records app/process RSS, macOS physical footprint, main and renderer heaps, per-utility memory, PTY-host descriptors and PTMX handles, renderer frame gaps, and whole-cycle duration. The stable panel and project-view counts are asserted after every measured cycle so topology growth cannot masquerade as a memory leak.

```bash
MEM_GROWTH_LABEL=before MEM_GROWTH_OUTPUT=.tmp/perf-results/memory-growth/before.json npm run perf memory-growth
MEM_GROWTH_LABEL=after MEM_GROWTH_OUTPUT=.tmp/perf-results/memory-growth/after.json npm run perf memory-growth
npm run perf memory-growth-compare -- .tmp/perf-results/memory-growth/before.json .tmp/perf-results/memory-growth/after.json
```

Controls: `MEM_GROWTH_PROJECTS` (default `2`), `MEM_GROWTH_TERMINALS` (default `2` per project), `MEM_GROWTH_WARMUPS` (default `3`), `MEM_GROWTH_CYCLES` (default `10`), `MEM_GROWTH_SEED_OUTPUT_LINES` (default `5500` per terminal), `MEM_GROWTH_OUTPUT_LINES` (default `750` per terminal per cycle), `MEM_GROWTH_SETTLE_MS` (default `4000`), `MEM_GROWTH_EPHEMERAL` (`0` disables transient-terminal churn for diagnosis), `MEM_GROWTH_LABEL`, `MEM_GROWTH_OUTPUT`, and `MEM_GROWTH_TIMEOUT_MS`.

## GPU/compositor traces (`--trace`)

`--trace` makes the packaged app self-start Electron's `contentTracing` (categories `viz,gpu,cc,blink,toplevel,startup`) for the full startup-to-quit window, writing one trace per run to `.tmp/perf-results/trace-run-N.json`. This is the way to see why the compositor takes time between `main_window_shown` and the first painted frame.

The output is Chromium's JSON Trace Event Format — open it directly at https://ui.perfetto.dev (drag-and-drop the `.json` file, no conversion needed).

Tracing adds measurable overhead to the traced process, so `--trace` is opt-in and gated behind a second env flag (`DAINTREE_PERF_TRACE`) that normal runs never set. **Do not mix `--trace` runs into baseline timing numbers** — capture traces in a separate session. Trace files can be large (tens of MB) and are transient build artifacts under `.tmp/`.
