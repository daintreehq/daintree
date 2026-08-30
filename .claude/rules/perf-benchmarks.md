---
paths:
  - "scripts/perf/**"
---

# Performance benchmarks

Add one entry to the `REGISTRY` in `scripts/perf/index.ts` — the single `npm run perf <command>` dispatcher. **Never add a new `perf:*` script to `package.json`**; they were deliberately consolidated.

Perf baselines are harvested from a workflow artifact and committed by hand — the org bans Actions from opening PRs. Never commit locally generated baselines: machine-to-machine variance makes them meaningless as a gate.

A `durationMs: 0` in a scenario is a hardcoded sentinel, not a real measurement. A `>= 0` filter treats it as real and zeroes the p95.
