---
paths:
  - "scripts/perf/**"
---

# Performance benchmarks

Add one entry to the `REGISTRY` in `scripts/perf/index.ts` — the single `npm run perf <command>` dispatcher. **Never add a new `perf:*` script to `package.json`**; they were deliberately consolidated.

**Benchmarks never run automatically, and never as a matrix.** `performance.yml` was deleted and `run.ts` requires `--scenario` with exactly one id. Do not add a scheduled sweep: nothing gates on these numbers, so a sweep has no reader.

`.github/workflows/perf-ab.yml` is the one exception, and it is not a sweep: dispatch-only, one scenario, both trees measured in a single job on a single runner, and hard-refused for any target that is not a `count`, a `size` or a structural `ratio`. It verifies a claim already made on a real machine against Linux and Windows. Never extend it to durations — hosted runners vary 5-25% run to run, which is why rustc-perf, V8, Node core and bencher.dev all refuse shared cloud CI for wall-clock work.

**`.agents/skills/optimize` is the way a benchmark gets run.** It is a human-invoked, then fully autonomous skill that takes a freeform subject, resolves it to one benchmark or a same-subject handful, proves a correctness predicate first, and compares against a champion arm re-measured in the same session. It writes its target, predicate, guards, threshold and protocol to a `precommit.json` before the baseline, and hashes `scripts/perf/` into that record — so a claim measured against an edited harness fails its own gate. It ends in a pull request, gated on the full unit suite. A bare `npm run perf` invocation skips all of that, so a number from one is a reading, never a result — do not present it as evidence that something got faster. The runner does not enforce this and deliberately is not asked to: the skill's own steps are `npm run perf` commands, so any guard would be one an agent could satisfy by setting a variable.

Baselines are therefore local and machine-specific. The old rule against committing a locally generated baseline existed because it was a shared gate that a laptop number would have skewed; nothing gates now, and there is no CI to harvest from, so the right reference for your machine is one you measured on it. `--update-baseline` merges a single scenario into the existing file rather than replacing it.

A `durationMs: 0` in a scenario is a hardcoded sentinel, not a real measurement. A `>= 0` filter treats it as real and zeroes the p95.
