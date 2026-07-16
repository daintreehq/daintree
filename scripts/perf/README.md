# Performance Harness

This directory contains the benchmark harness for app-level performance regression tracking.

## Entry point

Every benchmark runs through one dispatcher, `scripts/perf/index.ts`, exposed as the `perf` npm script. `npm run perf list` prints the full command table; each command spawns its benchmark in its own process, so behavior matches invoking the underlying script directly. Add a benchmark by adding one entry to the `REGISTRY` in `index.ts` — nothing else changes.

```bash
npm run perf list
```

## Modes

- `smoke`: fast local smoke suite (not invoked by any workflow — run on demand)
- `ci`: broader validation — run on the daily schedule and via manual dispatch in `performance.yml`, not on PRs or merges
- `nightly`: full matrix + soak coverage (daily schedule / manual dispatch in `performance.yml`)
- `soak`: long-run stress focus (daily schedule / manual dispatch in `performance.yml`)

## Commands

```bash
npm run perf smoke
npm run perf ci
npm run perf nightly
npm run perf soak
```

## Outputs

Artifacts are written to `.tmp/perf-results/`:

- `*.raw.jsonl` - per-iteration raw samples
- `*.summary.json` - aggregate stats + budget results
- `*.report.md` - human-readable report
- `latest-<mode>.summary.json` / `latest-<mode>.report.md`

The cold recipe fanout benchmark writes its versioned, atomically updated result to `.tmp/perf-results/recipe-fanout.json` by default.

## Baselines

Baselines are read from `scripts/perf/config/baseline.<mode>.json`.

Update baseline after accepted optimization work:

```bash
npm run perf smoke -- --update-baseline
npm run perf ci -- --update-baseline
```

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
