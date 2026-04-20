# Performance Harness

This directory contains the benchmark harness for app-level performance regression tracking.

## Modes

- `smoke`: fast PR guardrails
- `ci`: broader merge validation
- `nightly`: full matrix + soak coverage
- `soak`: long-run stress focus

## Commands

```bash
npm run perf:smoke
npm run perf:ci
npm run perf:nightly
npm run perf:soak
```

## Outputs

Artifacts are written to `.tmp/perf-results/`:

- `*.raw.jsonl` - per-iteration raw samples
- `*.summary.json` - aggregate stats + budget results
- `*.report.md` - human-readable report
- `latest-<mode>.summary.json` / `latest-<mode>.report.md`

## Baselines

Baselines are read from `scripts/perf/config/baseline.<mode>.json`.

Update baseline after accepted optimization work:

```bash
npm run perf:smoke -- --update-baseline
npm run perf:ci -- --update-baseline
```

## Manual cold-start

`npm run perf:cold-start` is a manual, one-shot cold-start sampler. It launches
the packaged binary N times from a fresh profile, parses the NDJSON marks
(`DAINTREE_PERF_METRICS_FILE`) after each run, and prints an aggregated
p50/p95 table covering key phase durations, individual marks, and IPC
round-trip timings per channel. No thresholds, no baselines, no CI gating.

Requires a packaged binary under `release/` — build one first with `npm run package`
(or `npm run package:local` on macOS for an unsigned dev build).

```bash
npm run perf:cold-start                   # 5 runs, text table
npm run perf:cold-start -- --runs 10      # custom run count
npm run perf:cold-start -- --json         # structured JSON for diffing
```

IPC sampling is forced to 100% for this command so per-channel stats are
meaningful across a small number of runs.
