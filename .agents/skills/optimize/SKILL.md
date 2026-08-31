---
name: optimize
disable-model-invocation: true
description: "USE ONLY WHEN A HUMAN EXPLICITLY INVOKES IT — never auto-select or run this proactively: not after writing code that looks slow, not because a benchmark moved, not as a step inside another workflow. This is a deliberate, multi-hour optimisation loop against ONE named metric on ONE matrix scenario. Once a human explicitly starts it with /optimize (Claude Code) or $optimize (Codex), it establishes a before measurement, then repeatedly hypothesises a cause, changes the code, re-measures against the current best, and keeps or reverts on the evidence — until the target stops improving or the budget runs out. Any claim on a duration, memory or derived-ratio metric is made against a champion arm re-measured in the same session, interleaved with the candidate, because a stored result measured hours earlier records a different thermal state rather than a fair opponent. It ends with a before/after table and a percent improvement, or an honest report that no improvement was available. It refuses to start against a scenario with no correctness predicate, because a benchmark with no correctness predicate rewards breaking the feature."
---

# Optimize

> **Run this ONLY when a human explicitly invokes it.** Optimize is a deliberate, multi-hour loop that changes production code in pursuit of a number. Do NOT trigger it proactively: not because a benchmark drifted, not because some code looks inefficient, not as a finishing step after other work. This is enforced, not merely requested — the frontmatter sets `disable-model-invocation: true`, so the model cannot auto-select it. A human starts it explicitly. If you are here because you just noticed something slow, that is not a reason to optimize — file it and stop.

Take one metric and make it better, or prove that you cannot.

This is the other half of the measurement system. `scripts/perf/` answers _what is the number_; this skill answers _can the number be moved, and by how much_. It exists because the harness deliberately gates nothing: without a gate, an improvement is only real when somebody proves it. This is the somebody.

**"No improvement was available" is a successful outcome.** Most optimisation attempts fail. A run that tries six hypotheses, disproves all six, and writes down why is worth more than a run that ships a change with no evidence behind it. Never manufacture an improvement. Reverting everything and reporting an honest zero is a complete, correct run.

**Nothing in the harness will stop you fooling yourself.** It gates nothing — `perf compare` prints `REFUSED` and exits 0; a measurement issue is a warning and exits 0; a scenario whose feature you broke still produces a number. The one exit code worth acting on is `check-pair.mjs`'s, shipped beside this file: it reads the summary files itself and exits non-zero when they are not a result, and in `ab` mode it establishes that the six arms are six runs of the two trees you named — distinct files, distinct content, distinct `generatedAt`, sides alternating in time, every arm filtered to the scenario being claimed, every `sourceSha` clean and equal to the sha you passed — before computing the verdict, rather than leaving that arithmetic and that bookkeeping to a tired reader. Run it before every comparison.

**What it cannot see, because it only reads the files:** that the machine was quiet, that nothing else was building while an arm ran, that a summary was not hand-edited. It takes `generatedAt` and `sourceSha` as the runner stamped them, and three arms of a `count` metric legitimately carry identical numbers, so it cannot distinguish "the count is deterministic" from "these are the same measurement retyped". A green exit means the files are a result; it does not mean the session around them was clean. That part is yours, and so is every other guard in this document.

## Inputs — all seven required before you start

Ask for anything missing. Do not guess, and do not start with a partial set.

1. **The target, as a scenario id plus an exact metric path.** `PERF-105 metricStats.idleGitSpawns.max`. Not `PERF-105`, which reports nine metrics on a healthy run and lets you pick a winner after the fact. Not "make startup faster". One scalar that can go down.
2. **The correctness predicate** — the metric and value proving the feature still works while the target improves. `detectionMisses.max === 0`. See **The correctness predicate is mandatory**.
3. **The mode** the scenario runs in: `smoke`, `ci`, `nightly` or `soak`. Scenarios declare their modes and `run.ts` rejects an id that is not in the chosen one — PERF-002 is `ci`/`nightly` only, so `--mode smoke --scenario PERF-002` is a usage error, not a measurement.
4. **The machines.** Not "Windows" — _which_ machine, and how you reach it. See **Cross-machine work**.
5. **Guard metrics and their tolerances.** The other numbers that must not get worse, and by how much. Without these, moving cost from spawns into memory reads as a win.
6. **The E2E spec or bucket to run at the end, or explicit permission not to run E2E.** `CLAUDE.md` and `.claude/rules/testing.md` are unambiguous: only a human names the spec or bucket. You may not choose one.
7. **The budget** — hours, or a hypothesis count.

Restate all seven before starting, and record them.

### Only matrix scenarios

This loop drives `npm run perf <mode> -- --scenario <ID>` and `npm run perf compare`. That is the whole supported surface — and since nothing schedules a benchmark and `run.ts` refuses to run without exactly one `--scenario`, **this loop is the only way a matrix benchmark gets measured at all.** There is no whole-matrix run to fall back on and no CI producing numbers in the background: if you do not measure it here, nobody measures it.

The REGISTRY commands are **not** valid targets: `launch-ab` takes `--runs` and packaged-executable operands, `memory-growth` has its own bespoke comparator, `recipe-fanout` is env-var driven. None of them speaks the `--scenario/--json` protocol this loop depends on. If the human names one, say so and stop.

## The correctness predicate is mandatory

**A count goes to zero when the feature is broken.** A watcher that never arms spawns no processes. A cache that never writes is infinitely fast. A queue that drops messages has excellent throughput. Most scenarios now declare a `correctness` array naming the miss counts that prove the work happened — `PERF-100` declares `statusPassMisses` and `spawnObserverMisses`, so a `refresh()` rewritten to return immediately shows up as a miss instead of as the best duration and lowest spawn count the scenario has ever recorded. Some scenarios still declare nothing: `PERF-011` reports a `checksum` and a `switchWorkMs` and no miss count at all, and one in that state is not safe to optimise against blind. Read the target scenario's own `correctness` field rather than this paragraph — the roster moves.

So, before any measurement:

1. Read the target scenario. Find a metric that proves the work actually happened.
2. If one exists — `detectionMisses`, `faultInjectionMisses`, `refreshMisses`, an emit count, a row count — that is your candidate predicate.
3. **If none exists, STOP.** Report that the scenario cannot be safely optimised against and what predicate it would need. Do not add one yourself: a predicate written by the run that optimises against it is worthless, for the same reason a benchmark is.
4. **Confirm a _healthy_ run emits it.** Some scenarios have emitted a miss count only from the failure path, which is not a predicate at all: a healthy run supplies nothing, so there is nothing to check, and a scenario that silently stopped running reports no misses either. In the Phase 0 probe, the predicate must appear in `metricStats` with `count` equal to the aggregate's `runs`. Absent, or emitted on some iterations only, means you cannot use it — say so and stop rather than proceeding on the half of it that exists.
5. **Prove it can fail.** A predicate that reads `0` because nothing sets it is indistinguishable from one that reads `0` because the feature works, and no amount of checking `count` and `max` separates them. Once, at Phase 0: break the scenario's subject deliberately on a throwaway commit — make the refresh return immediately, drop the watcher — run three iterations, and confirm the predicate goes non-zero. Then `git reset --hard` it away. If you cannot construct that break cheaply, proceed but say so in the report: the predicate is then untested evidence, not proof.

The predicate is checked as an **absolute health condition every round**, not as "did not regress". A scenario that starts at `detectionMisses: 1` and stays at `1` is broken before you began and stays broken; treating that as passing is exactly the trap. It must hold on **every iteration**, not on average.

**The condition is `count === runs` AND `min === 0` AND `max === 0` — all three, every round.** `MetricStat.count` is the number of iterations that _emitted_ the metric, not the number that ran, so a predicate that vanished for fourteen of fifteen iterations still aggregates to `max: 0` and reads as perfect health: `max` alone cannot tell a working feature from an absent measurement. And `max === 0` is not "every sample was zero" — some predicates are signed subtractions where a negative means the subject produced _more_ than it was asked to, so a run of `[-1, 0]` has a max of zero and a full count while being plainly unhealthy. `check-pair.mjs` applies all three; do not simplify it back, and do not assume your runner warns about this — check it yourself.

**An improvement in the target with the predicate unhealthy is a bug, not a win.** Revert it, record it, move on. Do not try to repair it in the same round.

## Core Rules

- Always work on a branch cut from `origin/develop`. Never optimise on `develop` or `main`.
- **Measure before changing anything.** No before measurement means no table and no run.
- **One hypothesis per round.** Two changes means you cannot attribute the result and will keep the wrong one.
- **Compare each round against the current best, not the baseline.** Judging against the baseline keeps a hypothesis that made the best result worse, so long as it still beats where the run started. See Phase 1 step 3.
- **No claim on a machine-dependent metric without a fresh interleaved arm.** A stored file measured hours ago is not an opponent; it is a record of a different thermal state. See **Machine-dependent claims**.
- **Revert on the evidence, not the story.** A plausible mechanism is not a measurement.
- **Never touch any measurement surface.** Not the scenario, not its fixture, not `scripts/perf/lib/`, not `budgets.json`, not the protocol flags. If you believe the scenario measures the wrong thing, stop the run and say so — a real finding, but not an optimisation. The final diff must contain **no** changes under `scripts/perf/`; verify that before finalising.
- Keep the branch focused. No unrelated cleanup, no dependency bumps, no drive-by refactors.
- Do not modify user-owned agent config (`~/.claude`, `~/.codex`, `~/.gemini`, shell hooks).
- Read `CLAUDE.md`, `.claude/rules/perf-benchmarks.md` and `.claude/rules/testing.md` before touching production code. A faster app that breaks an architectural invariant is not shippable.
- Expect several hours. Reserve the last of the budget for final verification **and the headline A/B** — six more measured arms, so budget them from the start. A run that spends everything on hypotheses cannot prove the tree is green and has produced nothing usable, and one that skips the headline A/B may not state a percentage at all: raw numbers and an explanation, or nothing. Stopping a hypothesis short to protect that reserve is the right call.

## Long-Running Loop Discipline

Keep the working log in conversation context. Compaction is fine; keep updates concrete enough that a compacted summary preserves the branch, the seven inputs, the before numbers, every hypothesis and verdict, and the current best.

For a durable handoff across long waits, write `.tmp/optimize-<target>.md`. `.tmp` is gitignored. Do not commit it.

Track: branch, baseline sha and current champion sha; the seven inputs; before measurement (path, machine label, `sourceSha`, `gitVersion`, target value, predicate value); the precommitted statistic and threshold; the hypothesis ledger (number, change, result, KEPT/REVERTED, why); which tests have run since the last code change.

The shas are not bookkeeping. They are the only thing that ties a measurement file to the code it measured once the conversation has been compacted twice and every JSON in `.tmp/opt/` has a plausible-looking name.

## The Loop

### Phase 0 — preflight and baseline

1. **Preflight the tree.** `git status --porcelain` must be **empty**. A dirty tree stops the run: you will be reverting trees and switching between commits, so you would eventually destroy work that is not yours, and a measurement of a dirty tree cannot be labelled with the commit it measured. Report what is dirty and ask. `git fetch origin`, then branch from `origin/develop` and record the branch point as the **baseline sha**.
2. **Preflight the target.** Confirm the scenario exists in the chosen mode and that both the target metric and the correctness predicate are emitted:

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations 3 --label probe --json .tmp/opt/probe.json
   ```

   Read the JSON. Confirm the target metric path resolves, is finite, and is **not degenerate** — a zero usually means the scenario measured nothing, which is this loop's most dangerous starting state because it looks like a perfect score. Confirm the predicate is present and healthy on the terms above (`count === runs`, `max === 0`). If either is missing, stop.

   Use `.tmp/opt/` for every artifact — `/tmp` is not portable to Windows, and the harness creates parent directories.

3. **Baseline.**

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label before --json .tmp/opt/before.json
   ```

   Counts are near-deterministic: a handful of iterations is conclusive. Everything else needs 15–30 **and** the precommitment and paired A/B in **Machine-dependent claims** below.

4. **Record the protocol and the provenance.** Machine label, `<N>`, `<W>`, and the exact `--scenario` list: every later run uses exactly these. A different `--warmups` or `--iterations` makes `perf compare` refuse the machine-dependent rows, deliberately, because a protocol difference otherwise reads as a code difference. Then record `environment.sourceSha`, `environment.gitVersion` and `environment.electronVersion` from `before.json`, and confirm the sha is the branch point. A results file that cannot name the commit it measured cannot be tied to a checkpoint later, and `git rev-parse HEAD` at the end of the run will not tell you what the file was measuring at the start.

5. Set `.tmp/opt/best.json` = `.tmp/opt/before.json`, and record the commit it belongs to as the **champion sha**. This pairing — file plus sha — is what every round is judged against. A `best.json` whose `sourceSha` is not the champion sha is stale by definition: discard it and re-measure rather than reasoning about which tree produced it.

### Phase 1 — the loop

Repeat until the budget is spent or credible hypotheses run out.

1. **Form one hypothesis.** Name the mechanism and where it lives. "This looks inefficient" is not a hypothesis; "`GitStatusPass` re-stats every file because the gitDir is null, so the cheap path is never taken" is. Read the code first.

2. **Make the smallest change that tests it**, and **commit it on the branch before measuring it.** Not the prettiest fix — the smallest one that moves the named mechanism. Every measurement is of a committed tree: an uncommitted change leaves `sourceSha` naming the champion commit while the code being measured is something else, which is exactly the mislabelled-file failure this loop exists to avoid, and it also makes the A/B arms below impossible to switch between. `git status --porcelain` must be empty when a measurement starts.

3. **Re-measure with the identical protocol**, then gate the pair before you look at any number in it:

   ```bash
   npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label h<k> --json .tmp/opt/h<k>.json
   node .agents/skills/optimize/check-pair.mjs --scenario <ID> --target <metric path> --predicate <predicate> --expect-before-sha <champion sha> --expect-after-sha $(git rev-parse HEAD) .tmp/opt/best.json .tmp/opt/h<k>.json
   npm run perf compare .tmp/opt/best.json .tmp/opt/h<k>.json
   ```

4. **Hard-stop checks. `perf compare` and `run` exit 0 on every one of these, so the exit code you act on is `check-pair.mjs`'s:**
   - **Exit 1** → the pair is not a result. It fails on a protocol, machine, mode or `--scenario` selection mismatch, on a `sourceSha` that is not the tree you think you measured, on a `gitVersion` or `electronVersion` move between the two files, on a broken apparatus, and on a predicate that is unhealthy or under-emitted. In `ab` it also fails on repeated or copied arms, a chronology that is not interleaved, an arm that measured more than the target scenario, and a dirty `sourceSha`. Do not read the comparison. Fix the cause and re-measure.
   - **Exit 2** → the command line was wrong, so nothing was judged: a missing `--threshold` or `--expect-*-sha`, the same file passed as two arms, an even number of pairs, an expected sha that is not a sha. Fix the invocation and run it again — this says nothing about the measurement either way.
   - **Exit 3** → the runner did not stamp `sourceSha`, so neither file can be tied to a checkpoint. Proceed only if you measured both arms in this session, interleaved, and say so in the report. Never against a stored `best.json` in this state.
   - **Exit 4** (`ab` mode only) → the arms were sound and the hypothesis lost. Revert and record it as a disproof; it is not a broken run to retry.
   - `REFUSED` in the `perf compare` output → the comparison did not happen. `check-pair.mjs` catches every refusal cause it knows of, so a refusal it did not predict means the two runs differ in a way neither tool expected. Stop and find out what.
   - A `measurement-issues=` non-zero in the run header, or warnings in the compare output about a count no longer emitted or a count falling to zero → read them. They describe the dead-watcher shape, which looks identical to success.

5. **Check the predicate** on the round's own JSON — `count === runs` and `max === 0`. `check-pair.mjs` does this for the file pair; if you skipped it for any reason, do it by hand. Unhealthy → revert, record, next hypothesis.

6. **Check the guard metrics** against their declared tolerances. Outside tolerance → the change has a cost the human did not authorise. Revert it, or stop and ask. Do not keep it and mention it in the report. Machine-dependent guards are judged against the same drift **D** as the target: a guard that moved less than D has not been shown to move, and one that moved more than D _and_ outside tolerance is a real cost, not noise. Reading a guard as noise on grounds you would not accept for the target is how a win gets bought with an unreported regression.

7. **Decide:**
   - Improvement over **best**, predicate healthy, guards inside tolerance → confirm it reproduces before keeping. For a `count`, `size` or `ratio` target one clean re-measurement is enough; these are near-deterministic. For anything else — `duration`, `memory`, `derived-ratio`, `unknown` — run the paired A/B in **Machine-dependent claims**, which is the only evidence that survives a four-hour thermal drift. Then KEEP: the `h<k>` commit becomes the new champion, `.tmp/opt/best.json` becomes its measurement, and the champion sha becomes `git rev-parse HEAD`.
   - No movement, or inside the noise → REVERT with `git reset --hard <champion sha>`, which discards the `h<k>` commit and returns the tree to the champion exactly. Record the disproof; it has value.
   - Regression → REVERT.

8. **Run the narrow vitest** for the touched files before the next round. A round that breaks a test and moves on compounds.

9. Record the round. Go again.

### Phase 2 — other machines

An improvement measured on one machine is a claim about one machine.

- Re-measure the final tree on each additional machine against **that machine's own before file**, same protocol. `perf compare` refuses a cross-machine machine-dependent comparison and the refusal is correct.
- **Only `count`, `size` and `ratio` compare across machines.** `duration`, `memory`, `derived-ratio` and `unknown` do not, and each machine gets its own before/after pair and its own percentage. `derived-ratio` is the class that catches people out: `memoryGrowthPct`, `cpuPct` and `eventLoopUtilization` look normalised, but dividing a runtime number by another runtime number changes the units the machine is in, not whether it is there — a slower CPU raises event-loop utilization for identical work. A percentage is not automatically portable. `scripts/perf/lib/comparability.ts` is the authority; run `classifyMetric` on the name in your head before writing a cross-machine row, and if you are unsure, it is machine-dependent.
- An improvement on one OS and not another is a finding worth reporting, not a failure to hide.

### Phase 3 — prove the tree is still good

After the last code change, with budget reserved for it:

1. `npm run typecheck`
2. `npm test` — the **full** suite. Scoped runs have repeatedly hidden failures here.
3. `npm run check` if anything touched types, IPC, keybindings, plugin manifests, or lint-visible code.
4. **The E2E spec or bucket the human named** (input 6), after `npm run build:e2e`. E2E runs against the built app — a stale or failed build silently tests the code you were trying to change. If the human gave no spec, run none and say so in the report.
5. `git diff --stat` against the branch point: confirm **nothing under `scripts/perf/` changed**.
6. **The headline measurement: a fresh paired A/B of the baseline sha against the final tree**, run now, in one session, on the machine you are claiming for. Not `before.json` — that file is hours old and was measured on a colder machine, and the whole run has been selecting hypotheses on differences of the size that drift produces. Whatever the rounds decided, the number in the report comes from this one pairing of the two trees that matter. For a `count`, `size` or `ratio` target a single clean pair suffices; for anything else use the full procedure in **Machine-dependent claims**. If the headline A/B does not meet all three conditions in **Machine-dependent claims**, **the improvement was not real**: this is Case 1, not a hedged Case 2. Reset the branch, report the headline numbers, and say the intermediate rounds over-read the noise. That verdict will feel wrong after hours of work on a change you can explain — the mechanism being plausible is what made it worth testing, and is not evidence that it worked.

If a test fails: reproduce it narrowly, and decide whether it is a real break from your change or a known flake (`.claude/rules/testing.md` — a worker crash after all tests pass is a flake; a teardown-timer failure naming a new file is real). A real break your change caused and cannot fix means finalising as **blocked**, with the branch left for the human.

## Machine-dependent claims

Anything that is not a `count`, a `size` or a structural `ratio` is the weakest thing this harness measures and the easiest to lie with — durations, memory readings, and the `derived-ratio` class that looks normalised and is not.

**Before the first such measurement, precommit in writing:** the statistic (median, not p95), the iteration count, and the minimum difference you will call meaningful. Then do not change them. Deciding to run "one more round" because the last was unfavourable turns a null result into a false positive.

### The paired A/B

A stored `best.json` is not an opponent. Over a multi-hour run the machine heats, background load shifts, and a champion measured cold at hour zero loses to nothing at all by hour four. Selecting the best-looking of twenty hypotheses against that file is selecting on drift. So for every machine-dependent claim, both arms are measured now, alternating, and the claim is made against the arm you just measured.

Both trees must already be commits — the champion sha and the candidate sha — because `sourceSha` is what proves each arm measured what it says it did.

```bash
BRANCH=$(git branch --show-current); CHAMP=<champion sha>; CAND=$(git rev-parse HEAD)
arm() { git switch --detach "$1" && npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label "$2" --json ".tmp/opt/ab/$2.json"; }
arm "$CHAMP" champ1 && arm "$CAND" cand1
arm "$CAND" cand2 && arm "$CHAMP" champ2
arm "$CHAMP" champ3 && arm "$CAND" cand3
git switch "$BRANCH"
```

Three pairs minimum, uninterrupted, with nothing else running on the machine. Never all-champion-then-all-candidate: that arrangement cannot separate your change from the hour that passed. The middle pair runs in reverse order because the first arm of a session is the coldest, and a fixed order hands that handicap to the same side three times. `--scenario` is required on every arm — the runner refuses to start without exactly one id, so an unfiltered run is not a mistake you can make. What still writes a tracked file under `scripts/perf/history/` is any arm without a sampling override, which dirties the tree the next `git switch` needs clean. Pass `--iterations`/`--warmups` on the A/B arms, as the recipe above already does, and history stays out of your diff.

None of that shape is on your honour: `check-pair.mjs ab` reconstructs the running order from the arms' own `generatedAt` stamps and refuses three champion runs followed by three candidate ones, an order that never reverses, and arms passed in an order other than the one they were measured in. Pass `--champ`/`--cand` in measurement order, oldest first — the pairing it judges on is `champ<k>` against `cand<k>`, and that only means something if those two runs were the two that ran back to back.

Then the verdict — computed, not eyeballed. The arithmetic here is the judgement call this whole procedure exists to remove, and an 8% improvement against a 6% drift looks like a win to anyone who has spent four hours earning it:

```bash
node .agents/skills/optimize/check-pair.mjs ab --scenario <ID> --target <metric path> --predicate <predicate> --threshold <precommitted %> --expect-champ-sha "$CHAMP" --expect-cand-sha "$CAND" --champ .tmp/opt/ab/champ1.json --champ .tmp/opt/ab/champ2.json --champ .tmp/opt/ab/champ3.json --cand .tmp/opt/ab/cand1.json --cand .tmp/opt/ab/cand2.json --cand .tmp/opt/ab/cand3.json
```

`--expect-champ-sha` and `--expect-cand-sha` are required. Without them the tool can only see that the arms came from two different trees, not that they came from _your_ two trees, and "some other tree beat the champion" is not the claim you are making.

Before it computes anything it establishes that the six files are six runs of those two trees. It refuses arms that are not comparable; the same file, or a copy of it, supplied as two arms; two arms stamped with the same `generatedAt`; a running order that is not interleaved; an arm that measured anything other than the target scenario; and any `sourceSha` that is `-dirty`, `-dirty-unknown`, or not the sha you named — a dirty arm measured a tree that is not the commit it claims, which is the shape of forgetting to commit the candidate. Then it rules on the three conditions:

1. The candidate won **every** index-paired arm — `champ1` against `cand1`, and so on. One loss and there is no claim, whatever the medians say.
2. The median-to-median improvement is at least `--threshold`. That number is the one you precommitted, and passing it on this command line is what stops it being chosen after the result is visible.
3. The improvement is larger than **D**, the worst champion-vs-champion spread, which the tool computes from the three champion arms. Identical code on both sides, so D is the machine. If your change moved the number by less than the machine moves it on its own, you measured the machine.

`VERDICT: CLAIM` and exit 0, or `VERDICT: NO CLAIM` and **exit 4**. Exit 4 is a complete result, not a run to retry: extending to more pairs after seeing an unfavourable number is the same fallacy as re-choosing the threshold. Pick the pair count up front — three, or any odd number above it — and quote D in the report so a reader can check the arithmetic without redoing it.

### Everything else about durations

- **p95 at low iteration counts is effectively one of the two largest samples.** `perf compare` leads with the median for that reason and marks p95 exploratory below 20 runs. Never claim a p95 improvement from 8 samples.
- `perf compare` is explicitly **descriptive** — it computes no confidence interval and no significance test. It cannot tell you a 5% difference is real. If you cannot precommit a threshold you believe in, **report the raw before/after numbers with no percentage claim**. That is honest; a percentage you cannot defend is not.
- Abort a contaminated run — a background install, a build, another agent on the machine. Redo the whole interleave, not the contaminated arm: replacing one arm and keeping its partner reintroduces exactly the pairing this procedure exists to prevent. Never delete inconvenient outliers after seeing them.
- Plugged in, low-power mode off, heavy background work closed.

Counts, sizes and structural ratios have none of these problems: 16 → 0 is real on the first run, and the interleave is not required for them.

## Cross-machine work

Ask for the **execution topology**, not just the OS list: which physical machines, how you reach each one, and whether the human will run a leg themselves.

- **Hosted CI cannot produce a machine-dependent before/after.** Every hosted job gets a fresh VM from a pool of varying hardware, and `run.ts` folds the run id into the machine label precisely so two hosted runs are refused as different machines. CI can measure counts and sizes; it cannot measure a duration, memory or `derived-ratio` delta, and the paired A/B cannot be run there because the two arms would land on two different VMs.
- An unattended session on one machine cannot simply proceed to another. If a leg needs a machine you cannot reach, say so, produce the legs you can, and mark the rest not measured.

## Fixing Guidelines

- Fix the mechanism, not the symptom. Caching a slow call is sometimes right and sometimes hides that the call should not happen — #12042 was caused by a cache doing exactly that.
- Watch for **moving** work rather than removing it. Ten spawns becoming one resident daemon is a 90% win on the spawn count and may be worse overall. That is what the guard metrics are for.
- Respect the product invariants in `CLAUDE.md`. Never modify user-owned agent config for speed. Never trade an observation for an interpretation.

## Finalization

Three cases. The first two are complete, correct outcomes.

### Case 1 — nothing improved

`git reset --hard <baseline sha>`, confirm `git status --porcelain` is empty and `git diff origin/develop` is empty, then delete the branch. The per-hypothesis commits go with it; nothing lands.

Report the target and its before value, every hypothesis with the measured reason it was rejected, and what you would try next or why you believe the number is at its floor. **Commit nothing to `develop`** — never an empty or marker commit. The evidence is the report.

### Case 2 — something improved

1. Squash the kept `h<k>` commits into one focused commit (or a few coherent ones), message per project convention. Squashing rewrites the sha, so the headline A/B must have been run **before** this step, against the sha it actually measured.
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
Trees: <baseline sha> → <final sha> · git <version> · Electron <version>
Statistic: <median|count> · precommitted threshold: <value> · measured drift D: <value|n/a>
```

- One block per machine. Never merge two machines into one table.
- Both numbers come from the **headline A/B** (Phase 3 step 6), not from files measured earlier in the run. Paste `check-pair.mjs ab`'s verdict block verbatim below the table: it carries D, the per-pair results and the threshold the verdict actually used, so the report cannot quote a threshold the tool was not given.
- The correctness predicate is always a row, and its cell reads `ok` only when `count === runs` and `max === 0` on both sides. A reader must see the feature still works and that the check was actually taken.
- Every declared guard metric is a row, including ones that moved the wrong way.
- Percentages only where the comparison is legitimate — never across machines for anything outside `count`, `size` and `ratio`, and never on a machine-dependent metric whose threshold you did not precommit or whose improvement did not exceed D.
- If the runner did not stamp `sourceSha` (`check-pair.mjs` exit 3), the Trees line says so, and the report states that the arms are tied to the checkpoint only by the fact that you measured them yourself, back to back.
- Below the table: the hypothesis ledger, one line each, including the rejected ones. The rejections are most of the value.

## Related

- `check-pair.mjs`, beside this file — the pre-compare gate, and the only exit code in this loop worth acting on. It reads files; the caveat on what that cannot cover is at the top of this document.
- `scripts/perf/README.md` — the harness, its modes, and every `npm run perf` command.
- `.claude/rules/perf-benchmarks.md` — never add a `perf:*` script to package.json; baselines are local, per-machine, and merged one scenario at a time.
- `scripts/perf/lib/comparability.ts` — which metrics compare across machines, and why a runtime-derived percentage does not. Read it before claiming a cross-machine result.
- `.claude/rules/testing.md` — the E2E contract. Only a human names the spec.
- `.agents/skills/stabilize/` — whole-tree, all-OS validation. Different job: stabilize proves the tree is green, optimize moves one number.
