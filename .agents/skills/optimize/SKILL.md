---
name: optimize
disable-model-invocation: true
description: "USE ONLY WHEN A HUMAN EXPLICITLY INVOKES IT — never auto-select or run this proactively: not after writing code that looks slow, not because a benchmark moved, not as a step inside another workflow. This is a deliberate, multi-hour optimisation loop against ONE named metric on ONE matrix scenario. Once a human explicitly starts it with /optimize (Claude Code) or $optimize (Codex), it establishes a before measurement, then repeatedly hypothesises a cause, changes the code, re-measures against the current best, and keeps or reverts on the evidence — until the target stops improving or the budget runs out. It ends with a before/after table and a percent improvement, or an honest report that no improvement was available. It refuses to start against a scenario with no correctness predicate, because a benchmark with no correctness predicate rewards breaking the feature."
---

# Optimize

> **Run this ONLY when a human explicitly invokes it.** Optimize is a deliberate, multi-hour loop that changes production code in pursuit of a number. Do NOT trigger it proactively: not because a benchmark drifted, not because some code looks inefficient, not as a finishing step after other work. This is enforced, not merely requested — the frontmatter sets `disable-model-invocation: true`, so the model cannot auto-select it. A human starts it explicitly. If you are here because you just noticed something slow, that is not a reason to optimize — file it and stop.

Take one metric and make it better, or prove that you cannot.

This is the other half of the measurement system. `scripts/perf/` answers _what is the number_; this skill answers _can the number be moved, and by how much_. It exists because the harness deliberately gates nothing: without a gate, an improvement is only real when somebody proves it. This is the somebody.

**"No improvement was available" is a successful outcome.** Most optimisation attempts fail. A run that tries six hypotheses, disproves all six, and writes down why is worth more than a run that ships a change with no evidence behind it. Never manufacture an improvement. Reverting everything and reporting an honest zero is a complete, correct run.

**Nothing outside this document will stop you fooling yourself.** The harness gates nothing — `perf compare` prints `REFUSED` and exits 0; a measurement issue is a warning and exits 0; a scenario whose feature you broke still produces a number. Every guard here is a guard you must apply deliberately.

## Inputs — all seven required before you start

Ask for anything missing. Do not guess, and do not start with a partial set.

1. **The target, as a scenario id plus an exact metric path.** `PERF-105 metricStats.idleGitSpawns.max`. Not `PERF-105`, which has eight metrics and lets you pick a winner after the fact. Not "make startup faster". One scalar that can go down.
2. **The correctness predicate** — the metric and value proving the feature still works while the target improves. `detectionMisses.max === 0`. See **The correctness predicate is mandatory**.
3. **The mode** the scenario runs in: `smoke`, `ci`, `nightly` or `soak`. Scenarios declare their modes and `run.ts` rejects an id that is not in the chosen one — PERF-002 is `ci`/`nightly` only, so `--mode smoke --scenario PERF-002` is a usage error, not a measurement.
4. **The machines.** Not "Windows" — _which_ machine, and how you reach it. See **Cross-machine work**.
5. **Guard metrics and their tolerances.** The other numbers that must not get worse, and by how much. Without these, moving cost from spawns into memory reads as a win.
6. **The E2E spec or bucket to run at the end, or explicit permission not to run E2E.** `CLAUDE.md` and `.claude/rules/testing.md` are unambiguous: only a human names the spec or bucket. You may not choose one.
7. **The budget** — hours, or a hypothesis count.

Restate all seven before starting, and record them.

### Only matrix scenarios

This loop drives `npm run perf <mode> -- --scenario <ID>` and `npm run perf compare`. That is the whole supported surface.

The REGISTRY commands are **not** valid targets: `launch-ab` takes `--runs` and packaged-executable operands, `memory-growth` has its own bespoke comparator, `recipe-fanout` is env-var driven. None of them speaks the `--scenario/--json` protocol this loop depends on. If the human names one, say so and stop.

## The correctness predicate is mandatory

**A count goes to zero when the feature is broken.** A watcher that never arms spawns no processes. A cache that never writes is infinitely fast. A queue that drops messages has excellent throughput. `PERF-100` reports a duration and `gitSpawns` and _nothing else_ — a change making `refresh()` return immediately improves both numbers and destroys the feature. That scenario is not safe to optimise against blind.

So, before any measurement:

1. Read the target scenario. Find a metric that proves the work actually happened.
2. If one exists — `detectionMisses`, `faultInjectionMisses`, `refreshMisses`, an emit count, a row count — that is your predicate.
3. **If none exists, STOP.** Report that the scenario cannot be safely optimised against and what predicate it would need. Do not add one yourself: a predicate written by the run that optimises against it is worthless, for the same reason a benchmark is.

The predicate is checked as an **absolute health condition every round**, not as "did not regress". A scenario that starts at `detectionMisses: 1` and stays at `1` is broken before you began and stays broken; treating that as passing is exactly the trap. Normally the condition is `max === 0`. It must hold on **every iteration**, not on average.

**An improvement in the target with the predicate unhealthy is a bug, not a win.** Revert it, record it, move on. Do not try to repair it in the same round.

## Core Rules

- Always work on a branch cut from `origin/develop`. Never optimise on `develop` or `main`.
- **Measure before changing anything.** No before measurement means no table and no run.
- **One hypothesis per round.** Two changes means you cannot attribute the result and will keep the wrong one.
- **Compare each round against the current best, not the baseline.** See **The comparison that decides**.
- **Revert on the evidence, not the story.** A plausible mechanism is not a measurement.
- **Never touch any measurement surface.** Not the scenario, not its fixture, not `scripts/perf/lib/`, not `budgets.json`, not the protocol flags. If you believe the scenario measures the wrong thing, stop the run and say so — a real finding, but not an optimisation. The final diff must contain **no** changes under `scripts/perf/`; verify that before finalising.
- Keep the branch focused. No unrelated cleanup, no dependency bumps, no drive-by refactors.
- Do not modify user-owned agent config (`~/.claude`, `~/.codex`, `~/.gemini`, shell hooks).
- Read `CLAUDE.md`, `.claude/rules/perf-benchmarks.md` and `.claude/rules/testing.md` before touching production code. A faster app that breaks an architectural invariant is not shippable.
- Expect several hours. Reserve the last of the budget for final verification — a run that spends everything on hypotheses and cannot prove the tree is green has produced nothing usable.

## Long-Running Loop Discipline

Keep the working log in conversation context. Compaction is fine; keep updates concrete enough that a compacted summary preserves the branch, the seven inputs, the before numbers, every hypothesis and verdict, and the current best.

For a durable handoff across long waits, write `.tmp/optimize-<target>.md`. `.tmp` is gitignored. Do not commit it.

Track: branch and current-best commit; the seven inputs; before measurement (path, machine label, target value, predicate value); the hypothesis ledger (number, change, result, KEPT/REVERTED, why); which tests have run since the last code change.

## The Loop

### Phase 0 — preflight and baseline

1. **Preflight the tree.** `git status --porcelain` must be clean — record anything dirty and do not touch it; you will be reverting things later and must never revert someone else's work. `git fetch origin`, then branch from `origin/develop`.
2. **Preflight the target.** Confirm the scenario exists in the chosen mode and that both the target metric and the correctness predicate are emitted:

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations 3 --label probe --json .tmp/opt/probe.json
   ```

   Read the JSON. Confirm the target metric path resolves, is finite, and is **not degenerate** — a zero usually means the scenario measured nothing, which is this loop's most dangerous starting state because it looks like a perfect score. Confirm the predicate is present and healthy. If either is missing, stop.

   Use `.tmp/opt/` for every artifact — `/tmp` is not portable to Windows, and the harness creates parent directories.

3. **Baseline.**

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label before --json .tmp/opt/before.json
   ```

   Counts are near-deterministic: a handful of iterations is conclusive. Durations need 15–30 **and** the precommitment in **Duration claims** below.

4. **Record the protocol**: machine label from `environment`, plus `<N>` and `<W>`. Every later run uses exactly these. A different `--warmups` or `--iterations` makes `perf compare` refuse the machine-dependent rows — deliberately, because a protocol difference otherwise reads as a code difference.

5. Set `.tmp/opt/best.json` = `.tmp/opt/before.json`. This is the file every round is judged against.

### Phase 1 — the loop

Repeat until the budget is spent or credible hypotheses run out.

1. **Form one hypothesis.** Name the mechanism and where it lives. "This looks inefficient" is not a hypothesis; "`GitStatusPass` re-stats every file because the gitDir is null, so the cheap path is never taken" is. Read the code first.

2. **Make the smallest change that tests it.** Not the prettiest fix — the smallest one that moves the named mechanism.

3. **Re-measure with the identical protocol**, then compare **against the current best**:

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label h<k> --json .tmp/opt/h<k>.json
   npm run perf compare .tmp/opt/best.json .tmp/opt/h<k>.json
   ```

4. **Hard-stop checks — `perf compare` and `run` both exit 0 on all of these, so you must look:**
   - `REFUSED` in the output → the comparison did not happen. Do not read the row as a result. Fix the protocol and re-measure.
   - A measurement-issues section, or `measurement-issues=` non-zero in the run header → the apparatus is broken. Stop and fix that before continuing; every number in the round is suspect.
   - The target metric or the predicate absent from the JSON → stop.
   - A mode or scenario-selection mismatch warning → stop.

5. **Check the predicate.** Unhealthy on any iteration → revert, record, next hypothesis.

6. **Check the guard metrics** against their declared tolerances. Outside tolerance → the change has a cost the human did not authorise. Revert it, or stop and ask. Do not keep it and mention it in the report.

7. **Decide:**
   - Improvement over **best**, predicate healthy, guards inside tolerance → re-measure once more to confirm it reproduces, then KEEP. Commit a checkpoint on the branch and copy the run to `.tmp/opt/best.json`.
   - No movement, or inside the noise → REVERT (`git checkout -- <files>` against the checkpoint). Record the disproof; it has value.
   - Regression → REVERT.

8. **Run the narrow vitest** for the touched files before the next round. A round that breaks a test and moves on compounds.

9. Record the round. Go again.

### Phase 2 — other machines

An improvement measured on one machine is a claim about one machine.

- Re-measure the final tree on each additional machine against **that machine's own before file**, same protocol. `perf compare` refuses a cross-machine duration comparison and the refusal is correct.
- **Counts, sizes and ratios compare across machines; durations and memory do not.** `scripts/perf/lib/comparability.ts` is the authority. If the target is a count, a cross-machine comparison belongs in the table. If it is a duration, every machine gets its own before/after pair and its own percentage.
- An improvement on one OS and not another is a finding worth reporting, not a failure to hide.

### Phase 3 — prove the tree is still good

After the last code change, with budget reserved for it:

1. `npm run typecheck`
2. `npm test` — the **full** suite. Scoped runs have repeatedly hidden failures here.
3. `npm run check` if anything touched types, IPC, keybindings, plugin manifests, or lint-visible code.
4. **The E2E spec or bucket the human named** (input 6), after `npm run build:e2e`. E2E runs against the built app — a stale or failed build silently tests the code you were trying to change. If the human gave no spec, run none and say so in the report.
5. `git diff --stat` against the branch point: confirm **nothing under `scripts/perf/` changed**.
6. A final confirming measurement, so the table's after number comes from the tree you are leaving behind.

If a test fails: reproduce it narrowly, and decide whether it is a real break from your change or a known flake (`.claude/rules/testing.md` — a worker crash after all tests pass is a flake; a teardown-timer failure naming a new file is real). A real break your change caused and cannot fix means finalising as **blocked**, with the branch left for the human.

## Duration claims

Durations are the weakest thing this harness measures, and the easiest to lie with.

**Before the first duration measurement, precommit in writing:** the statistic (median, not p95), the iteration count, and the minimum difference you will call meaningful. Then do not change them. Deciding to run "one more round" because the last was unfavourable turns a null result into a false positive.

- **p95 at low iteration counts is effectively one of the two largest samples.** `perf compare` leads with the median for that reason and marks p95 exploratory below 20 runs. Never claim a p95 improvement from 8 samples.
- `perf compare` is explicitly **descriptive** — it computes no confidence interval and no significance test. It cannot tell you a 5% difference is real. If you cannot precommit a threshold you believe in, **report the raw before/after numbers with no percentage claim**. That is honest; a percentage you cannot defend is not.
- Interleave for a marginal claim. All-after-then-all-before confounds the change with thermal state and background load.
- Abort a contaminated run — a background install, a build, another agent on the machine. Redo it. Never delete inconvenient outliers after seeing them.
- Plugged in, low-power mode off, heavy background work closed.

Counts have none of these problems: 16 → 0 is real on the first run.

## Cross-machine work

Ask for the **execution topology**, not just the OS list: which physical machines, how you reach each one, and whether the human will run a leg themselves.

- **Hosted CI cannot produce a duration before/after.** Every hosted job gets a fresh VM from a pool of varying hardware, and `run.ts` folds the run id into the machine label precisely so two hosted runs are refused as different machines. CI can measure counts; it cannot measure a duration delta.
- An unattended session on one machine cannot simply proceed to another. If a leg needs a machine you cannot reach, say so, produce the legs you can, and mark the rest not measured.

## Fixing Guidelines

- Fix the mechanism, not the symptom. Caching a slow call is sometimes right and sometimes hides that the call should not happen — #12042 was caused by a cache doing exactly that.
- Watch for **moving** work rather than removing it. Ten spawns becoming one resident daemon is a 90% win on the spawn count and may be worse overall. That is what the guard metrics are for.
- Respect the product invariants in `CLAUDE.md`. Never modify user-owned agent config for speed. Never trade an observation for an interpretation.

## Finalization

Three cases. The first two are complete, correct outcomes.

### Case 1 — nothing improved

Revert every change you made — and only yours; leave any pre-existing dirty files recorded at preflight untouched. The branch holds no production changes.

Report the target and its before value, every hypothesis with the measured reason it was rejected, and what you would try next or why you believe the number is at its floor. Delete the branch. **Commit nothing** — never an empty or marker commit. The evidence is the report.

### Case 2 — something improved

1. Squash the checkpoints into one focused commit (or a few coherent ones), message per project convention.
2. State the measured improvement and the machine it was measured on. No AI attribution.
3. Leave the branch for the human. **Do not push and do not open a PR unless asked.**

### Case 3 — blocked

A test or E2E failure your change caused and could not fix. Leave the branch, report the failing test, the narrowest reproduction, and which hypothesis introduced it.

### The report — required in every case

```
## <scenario> <metric path> — <machine label>

| Metric                 | Before | After | Change |
| ---------------------- | -----: | ----: | -----: |
| <target metric>        |     16 |     2 | −87.5% |
| <correctness predicate>|      0 |     0 |     ok |
| <guard metric>         |    412 |    418 | +1.5% |

Machine: <label> (<platform>/<arch>) · mode <mode> · <N> iterations · <W> warmups
Statistic: <median|count> · precommitted threshold: <value>
```

- One block per machine. Never merge two machines into one table.
- The correctness predicate is always a row. A reader must see the feature still works.
- Every declared guard metric is a row, including ones that moved the wrong way.
- Percentages only where the comparison is legitimate — never a cross-machine duration percentage, and never a percentage on a duration whose threshold you did not precommit.
- Below the table: the hypothesis ledger, one line each, including the rejected ones. The rejections are most of the value.

## Related

- `scripts/perf/README.md` — the harness, its modes, and every `npm run perf` command.
- `.claude/rules/perf-benchmarks.md` — never add a `perf:*` script to package.json; baselines are harvested by hand.
- `scripts/perf/lib/comparability.ts` — which metrics compare across machines. Read it before claiming a cross-machine result.
- `.claude/rules/testing.md` — the E2E contract. Only a human names the spec.
- `.agents/skills/stabilize/` — whole-tree, all-OS validation. Different job: stabilize proves the tree is green, optimize moves one number.
