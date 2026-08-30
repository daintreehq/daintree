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

- **Machine-independent** — counts, byte sizes and ratios. Compare these freely across machines and operating systems: "Windows 34, macOS 0" is a finding.
- **Machine-dependent** — wall-clock durations and runtime memory. Only meaningful against another run on the _same_ machine. Across two machines the difference is mostly the two machines.

Counts are also the class that catches the bug latency benchmarks are blind to: a recovery state machine that takes a wrong turn under a transient fault and never returns to the cheap path keeps every individual operation fast. Only a count over a fixed idle window sees it. PERF-105/106 exist for exactly that shape.

**Every count needs a paired correctness reading.** A dead watcher spawns nothing and scores perfectly. Scenarios carry a `*Misses` metric so a broken feature cannot be reported as a win — PERF-105's zero idle spawns is only meaningful beside `detectionMisses: 0`, which proves the edit was still detected.

## Known gap: `scripts/perf` is not type-checked

`npm run typecheck` covers **zero files** under `scripts/perf` — `scripts/` appears in no tsconfig's `include`. The harness is gated by execution (`npm test` and real benchmark runs) and by nothing else, so a rename can silently break a fixture and every test still passes: vitest transpiles without checking types.

This is not hypothetical. Two real instances found while this directory was being reworked:

- `scripts/perf/scenarios/ipc.ts` called a function that had been renamed out from under it. `npm run typecheck` passed; only a real benchmark run caught it.
- `lib/worktreeSidebarFixture.ts` calls `svc.loadProject(requestId, repoPath)` where the signature now takes 3–6 arguments.

To see the real state:

```bash
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext \
  --moduleResolution bundler --types node --allowImportingTsExtensions \
  --resolveJsonModule scripts/perf/run.ts
```

Wiring this into `typecheck:projects` was attempted and reverted. It surfaces roughly 30 further pre-existing errors — `migrationFixture.ts` has drifted from `StoreSchema`, `agentAnalysisSim.ts` has unguarded optionals, `archiver` has no types — and the module graph transitively pulls in `src/` and `electron/`, so the config also needs their path aliases. Closing this properly is its own piece of work.

## Entry point

Every benchmark runs through one dispatcher, `scripts/perf/index.ts`, exposed as the `perf` npm script. `npm run perf list` prints the full command table; each command spawns its benchmark in its own process, so behavior matches invoking the underlying script directly. Add a benchmark by adding one entry to the `REGISTRY` in `index.ts` — nothing else changes.

```bash
npm run perf list
```

## Modes

- `smoke`: fast local suite — the one to use while iterating
- `ci`: broader validation — daily schedule and manual dispatch in `performance.yml`, on **ubuntu-22.04, windows-2022 and macos-14**. Gates no pull request.
- `nightly`: full matrix + the packaged-binary scenario, plus baseline regeneration (Linux only)
- `soak`: long-run stress focus

A scenario declares which modes it runs in, and an id outside the chosen mode is a usage error — `--mode smoke --scenario PERF-002` fails, because PERF-002 is `ci`/`nightly` only.

## Commands

```bash
npm run perf smoke
npm run perf ci
npm run perf nightly
npm run perf soak
```

### Running one benchmark

The flags that make the local optimisation loop work:

```bash
npm run perf smoke -- --scenario PERF-105 --iterations 5 --label before --json .tmp/opt/before.json
```

| Flag | Effect |
| --- | --- |
| `--scenario <ids>` | Repeatable and comma-separated. Unknown id → error listing the available ones |
| `--iterations <n>` | Overrides the per-tier default for every scenario in the run |
| `--warmups <n>` | Overrides each scenario's own warmup count |
| `--label <name>` | Stamped into the summary — `before`, `after`, `pin-backend` |
| `--json <path>` | Writes the summary somewhere you chose, for `perf compare` |
| `--machine <label>` | Overrides the machine identity (or set `PERF_MACHINE_LABEL`) |
| `--update-baseline` | Regenerates the mode's baseline. Rejected alongside `--scenario` |

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

Every unfiltered run writes `scripts/perf/history/<mode>.<machineLabel>.json` — a small **tracked** file, so `git log -p scripts/perf/history/` answers "when did this get slower" months later. It records p50, p95 and each metric's max, sum and own sample count.

CI does not commit history. Hosted runners fold the run id into the machine label because every job is a fresh VM, so a committed CI history file would be per-run noise, incomparable to the last. Hosted history ships as an artifact; the committed record comes from real, stable machines run by hand.

## Outputs

Artifacts are written to `.tmp/perf-results/`:

- `*.raw.jsonl` - per-iteration raw samples
- `*.summary.json` - aggregate stats + budget results
- `*.report.md` - human-readable report
- `latest-<mode>.summary.json` / `latest-<mode>.report.md`

The cold recipe fanout benchmark writes its versioned, atomically updated result to `.tmp/perf-results/recipe-fanout.json` by default.

## Subsystem scenarios (PERF-043..046, 053..058, 074..077, 092..094)

Four families drive the real production subsystem in a real process rather than a stand-in. Each one grew out of replacing a simulation that had drifted from what the code does, so the scope limits below are the point, not boilerplate — several of these measure a floor with a named piece of production deliberately out of frame.

- **Cross-process IPC hosts (PERF-043/044/045/046)** — the actual `workspace-host` and `pty-host` forked into their own processes with `serialization: "advanced"`, so structured-clone cost is real. PERF-043 times boot-to-ready, proves the host serves a health check, and confirms it exits on a clean dispose. PERF-044 runs 100 correlated round trips and reports messages and serialized bytes each way, with a 64-character nonce per request that must come back intact. PERF-045 streams 2000 indexed lines from one real PTY and prices the parent-IPC **fallback** channel — production's visual path is the renderer MessagePort, which a forked child's channel cannot carry, so this is a volume figure, not the paint path. PERF-046 SIGKILLs the workspace host three times and measures respawn-to-ready; `WorkspaceHostProcess` (crash classification, restart backoff, state replay) is not in the loop, so it answers how fast a killed host comes back, not whether Daintree would have restarted it.
- **Persistence engines (PERF-053..058)** — better-sqlite3 and electron-store at engine level, against a migrated and populated database opened with production's pragmas. PERF-053 contrasts 200 autocommit upserts with the same 200 in one transaction; PERF-054 asserts the query plans so an index that stops being used shows up as a plan change and not just a slower number; PERF-055 adds a concurrent reader, a bounded write-lock contention probe and a TRUNCATE checkpoint; PERF-056 walks the real drizzle migration chain over 4,000 seeded rows so the O(rows) table rewrites are priced. On the JSON side, PERF-057 writes a 400-panel `appState` snapshot and then twelve ordinary settings writes against the now-large file — the whole-file rewrite amplification is the number to read, and it is large. PERF-058 pairs `initializeStore()` through the real corrupt-config preflight with 200 uncached `conf` reads against 200 through the product's cached store proxy.
- **Project view lifecycle (PERF-074/075/076/077)** — a real `ProjectViewManager` over real `WebContentsView`s. PERF-074 rotates inside the cache limit and counts warm reactivations against cold starts, checking the wake signal each warm switch must emit. PERF-075 forces an eviction on every switch and validates LRU order and teardown against the manager's own state. PERF-076 drives the graduated pressure ladder and the forced tier-2 reclaim with one view holding an active agent and one a live assistant backend, checking the per-pass budget, the soft agent tier's ordering and the hard assistant floor. PERF-077 queues A-B-C-A-D onto the switch chain in a single tick without draining between them, then reads the settled active view, resident set and window child stack — the manager queues switches and never supersedes one, so this is where that shows.
- **Idle subsystems (PERF-092/093/094)** — the idle-tax counterpart to PERF-105/106, on the process-tree poller instead of the git watcher. PERF-092 idles a real `ProcessTreeCache` with a real subscriber at the pty-host's own 1500ms cadence for 15s, reporting subprocess starts, refresh callbacks, in-process CPU per idle second and event-loop utilization, paired with the discovery latency of a child spawned after the window closes. PERF-093 is the #12042 shape generalised: a PATH shim breaks the `ps`/`powershell` probe for 8s and then heals, and the run reports the cost of idling while broken, the recovery latency, and whether the poller returned to the cheap path over an identical window afterwards. PERF-094 stacks twenty watcher-less `WorktreeMonitor`s — the poll-fallback population beyond the background watcher budget — at the performance profile's 5000ms cadence alongside the process tree, paired with per-monitor poll-tick liveness, a staged file change that must still be detected, and a child that must still be discovered.

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
npm run perf smoke -- --update-baseline
npm run perf ci -- --update-baseline
```

Baselines are runner-specific — regenerate them on the machine class they describe, and never commit one generated on a laptop. CI regenerates all four modes in `perf-nightly` and uploads them as the `perf-baselines` artifact; a human harvests and commits them, because the org blocks Actions from opening pull requests. `--update-baseline` is rejected alongside `--scenario`, since a filtered run would replace every other scenario's reference with nothing and the resulting file is indistinguishable from a complete one.

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
