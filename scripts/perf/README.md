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

## GPU/compositor traces (`--trace`)

`--trace` makes the packaged app self-start Electron's `contentTracing` (categories `viz,gpu,cc,blink,toplevel,startup`) for the full startup-to-quit window, writing one trace per run to `.tmp/perf-results/trace-run-N.json`. This is the way to see why the compositor takes time between `main_window_shown` and the first painted frame.

The output is Chromium's JSON Trace Event Format — open it directly at https://ui.perfetto.dev (drag-and-drop the `.json` file, no conversion needed).

Tracing adds measurable overhead to the traced process, so `--trace` is opt-in and gated behind a second env flag (`DAINTREE_PERF_TRACE`) that normal runs never set. **Do not mix `--trace` runs into baseline timing numbers** — capture traces in a separate session. Trace files can be large (tens of MB) and are transient build artifacts under `.tmp/`.
