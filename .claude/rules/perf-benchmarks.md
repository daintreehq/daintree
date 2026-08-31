---
paths:
  - "scripts/perf/**"
---

# Performance benchmarks

Add one entry to the `REGISTRY` in `scripts/perf/index.ts` — the single `npm run perf <command>` dispatcher. **Never add a new `perf:*` script to `package.json`**; they were deliberately consolidated.

**Benchmarks never run automatically, and never as a matrix.** There is no perf workflow — `performance.yml` was deleted — and `run.ts` requires `--scenario` with exactly one id. Runs are started by hand or by `.agents/skills/optimize`, one benchmark at a time. Do not add a scheduled sweep: nothing gates on these numbers, so a sweep has no reader.

Baselines are therefore local and machine-specific. The old rule against committing a locally generated baseline existed because it was a shared gate that a laptop number would have skewed; nothing gates now, and there is no CI to harvest from, so the right reference for your machine is one you measured on it. `--update-baseline` merges a single scenario into the existing file rather than replacing it.

A `durationMs: 0` in a scenario is a hardcoded sentinel, not a real measurement. A `>= 0` filter treats it as real and zeroes the p95.
