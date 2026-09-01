---
name: optimize
disable-model-invocation: true
argument-hint: "<freeform: one benchmark, one subsystem, or an area to pick a cluster from> [--with PERF-xxx] [--budget Nh] [--os local|all] [--no-pr] [--dry-run]"
model: opus
description: "USE ONLY WHEN A HUMAN EXPLICITLY INVOKES IT — never auto-select or run this proactively: not after writing code that looks slow, not because a benchmark moved, not as a step inside another workflow. Once a human starts it with /optimize (Claude Code) or $optimize (Codex) it runs FULLY AUTONOMOUSLY to the end, never asking a question. It takes one freeform instruction and resolves it to ONE benchmark, or a small cluster of benchmarks that measure the same thing, sharing one subject and one likely fix — never a grab-bag of unrelated targets. It writes its decision down before measuring (metric, predicate, guards, threshold, protocol, apparatus hash), establishes a baseline, then hypothesises, changes code, re-measures against a champion arm re-measured in the same session, and keeps or reverts on the evidence. It re-measures every benchmark in the cluster against the branch point at the end, because one shared fix moves all of them. Local machine first to a claim, then the deterministic count/size/ratio legs on other operating systems via the perf-ab workflow; durations are never claimed off a shared CI runner. The full unit suite must pass before it opens a pull request. Ends with a before/after table per benchmark and machine and a pull request, or an honest report that no improvement was available and no pull request at all. Refuses a benchmark with no correctness predicate, because one that has none rewards breaking the feature."
allowed-tools:
  - Bash(pwd:*)
  - Bash(ls:*)
  - Bash(cat:*)
  - Bash(head:*)
  - Bash(tail:*)
  - Bash(wc:*)
  - Bash(mkdir:*)
  - Bash(cp:*)
  - Bash(mv:*)
  - Bash(rm:*)
  - Bash(ln:*)
  - Bash(echo:*)
  - Bash(sed:*)
  - Bash(awk:*)
  - Bash(grep:*)
  - Bash(rg:*)
  - Bash(find:*)
  - Bash(sort:*)
  - Bash(jq:*)
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(node:*)
  - Bash(npm:*)
  - Bash(npx:*)
  - Bash(taskpolicy:*)
  - Bash(caffeinate:*)
  - Grep
  - Glob
  - Read
  - Edit
  - Write
  - Skill
  - Agent
  - TaskOutput
  - mcp__codex__codex
  - mcp__ask-google__ask_google
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash -c 'INPUT=$(cat); CMD=$(echo \"$INPUT\" | jq -r \".tool_input.command // \\\"\\\"\"); case \"$CMD\" in *\"gh pr create\"*) HEAD=$(git rev-parse HEAD 2>/dev/null || echo none); REC=$(cat .tmp/optimize/tests-green 2>/dev/null || echo none); if [ \"$REC\" = \"$HEAD\" ]; then exit 0; fi; REASON=\"Phase 8 has not signed off this tree. .tmp/optimize/tests-green must hold the current HEAD ($HEAD); it holds $REC. Run npm run typecheck, the FULL npm test, and npm run check, write HEAD into that file only when all three are green, then open the pull request. A red or unproven suite never becomes a PR, and rewriting the tree after Phase 8 invalidates the receipt on purpose: re-run the suite and redo Cluster close.\"; jq -nc --arg r \"$REASON\" \"{hookSpecificOutput:{hookEventName:\\\"PreToolUse\\\",permissionDecision:\\\"deny\\\",permissionDecisionReason:\\$r}}\"; exit 0 ;; esac; exit 0'"
          timeout: 10
  PostToolUse:
    - matcher: "Skill"
      hooks:
        - type: command
          command: 'echo ''{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"OPTIMIZE CONTINUATION — a Skill call just returned. Never end your turn without text output. Re-read .tmp/optimize/ledger.md if you have lost your place; it is the source of truth for the branch, the cluster, the benchmark being worked, the champion sha and the hypothesis log. This run is fully autonomous: never ask the user anything, never end a turn on an open question. An open question is a decision you have not made yet — make it, write it in the ledger with its price, and keep going. Phases 3-5 cycle once per benchmark in the cluster; then phase 6 re-measures every one of them against the branch point, and that is not optional. Phase 8 must be fully green — typecheck, the FULL vitest suite, npm run check — before phase 9 opens the pull request. The run ends only when you emit the Final report with OPTIMIZE_COMPLETE."}}'''
          timeout: 5
  Stop:
    - blocking: true
      hooks:
        - type: command
          command: "bash -c 'INPUT=$(cat); TRANSCRIPT=$(echo \"$INPUT\" | jq -r \".transcript_path\"); for i in 1 2 3 4 5; do MSG=$(tail -n 100 \"$TRANSCRIPT\" 2>/dev/null | jq -r \"select(.type==\\\"assistant\\\" and ((.isSidechain // false) | not)) | [.message.content[]? | .text // empty] | join(\\\"\\\\n\\\") | select(length > 0) | tojson\" 2>/dev/null | tail -n 1); if echo \"$MSG\" | grep -qE \"OPTIMIZE_(COMPLETE|BLOCKED)\"; then exit 0; fi; sleep 0.3; done; echo \"{\\\"decision\\\":\\\"block\\\",\\\"reason\\\":\\\"RUN INCOMPLETE — no outcome sentinel in your last message. Read .tmp/optimize/ledger.md; it is the source of truth. Find the current phase and target and resume from there, not from the top. Phases 3-5 cycle once per benchmark in the cluster: precommit and baseline, hypothesis loop, local claim. When the cluster is worked you still owe phase 6 (re-measure EVERY kept benchmark against the branch point on the final tree — one shared fix moves all of them, so every earlier number is stale until redone), phase 7 (the cross-OS count legs, or a recorded reason there are none), phase 8 (typecheck, the FULL vitest suite, npm run check, and the diff audit proving nothing under scripts/perf changed), phase 9 (push and open the pull request) and phase 10 (the report). None is optional. Phase 8 is a HARD GATE on phase 9: a red unit suite means no pull request — fix it or revert the change that caused it, then rerun the whole suite. Phase 9 is skipped in exactly two cases, both of which still owe phases 6, 8 and 10: nothing improved, so there is no pull request to open — delete the branch and report the honest zero; or the human passed --no-pr, so you commit and report the branch name. A --dry-run run owes only phases 1-3 and the plan. This run is fully autonomous and you are pre-authorized for every remaining hypothesis, revert, measurement, the push and the pull request; never stop to ask whether to continue and never ask the user to choose. A check-pair exit 5 is not a disproof: the machine was too noisy and the pair must be measured again. Emit the Final report ending with OPTIMIZE_COMPLETE. Only for a physically unrecoverable blocker (repo corruption, the harness cannot run at all, a test failure your change caused that you can neither fix nor revert) emit OPTIMIZE_BLOCKED with the reason — never for something you are merely undecided about.\\\"}\"; exit 0'"
          timeout: 15
---

# Optimize

> **Run this ONLY when a human explicitly invokes it.** Optimize changes production code in pursuit of a number, for hours, unattended. Do NOT trigger it proactively: not because a benchmark drifted, not because some code looks inefficient, not as a finishing step after other work. This is enforced, not merely requested — `disable-model-invocation: true` means the model cannot auto-select it. If you are here because you just noticed something slow, that is not a reason to optimize: file it and stop.

Take a freeform instruction, resolve it to one benchmark — or a handful that measure the same thing — and move the number, or prove it cannot be moved.

**The unit of a run is one subject, not one area.** A run works `PERF-100` alone, or `PERF-100`/`PERF-101`/`PERF-103` together because all three price the same git status pass and one fix plausibly moves all three. It does not work "area A", which is twenty-four benchmarks over four different subsystems: that is a batch of runs, one per cluster, and `AREAS.md` is how they get handed out. A cluster whose members do not share a subject and a plausible common fix is not a cluster — it is a queue, and a queue makes every table in the report a claim about a tree some other target has since changed.

This is the other half of the measurement system. `scripts/perf/` answers _what is the number_; this skill answers _can the number be moved, and by how much_. It exists because the harness deliberately gates nothing: without a gate, an improvement is only real when somebody proves it. This is the somebody. And since nothing schedules a benchmark and `run.ts` refuses to run without exactly one `--scenario`, **this loop is the only way a matrix benchmark gets measured at all** — if you do not measure it here, nobody measures it.

**"No improvement was available" is a successful outcome.** Most optimisation attempts fail. A run that tries six hypotheses, disproves all six, and writes down why is worth more than a run that ships a change with no evidence behind it. Never manufacture an improvement. Reverting everything and reporting an honest zero is a complete, correct run.

**Nothing in the harness will stop you fooling yourself.** It gates nothing — `perf compare` prints `REFUSED` and exits 0; a measurement issue is a warning and exits 0; a scenario whose feature you broke still produces a number. The exit codes worth acting on belong to the three scripts shipped beside this file: `precommit.mjs` writes the decision down before the numbers exist and refuses to be rewritten afterwards, `check-pair.mjs` reads the summary files and refuses a pair that is not a result, and `harness-digest.mjs` proves the benchmark you are claiming against is the benchmark you started with.

**What those scripts cannot see, because they only read files:** that the machine was quiet, that nothing else was building while an arm ran, that a summary was not hand-edited. They take `generatedAt` and `sourceSha` as the runner stamped them, and three arms of a `count` metric legitimately carry identical numbers, so they cannot distinguish "the count is deterministic" from "these are the same measurement retyped". A green exit means the files are a result; it does not mean the session around them was clean. That part is yours, and so is every other guard in this document.

## Autonomy contract

**This run never asks the user anything.** There is no human to ask: `/optimize` is started and left, often overnight, often on one of several worker machines running different areas at once. Treat every input as freeform and every gap as yours to close.

- **Derive, record, proceed.** Everything the old fixed-input form demanded is already in the repository: the scenario declares its `modes` and its `correctness` predicate, the probe run lists every metric it emits, and the cost of one arm tells you the budget. Read them, decide, write the decision in the ledger with its reasoning, and move.
- **An open question is a decision you have not made yet.** Make it. Record what you chose and what it cost you. Never end a turn on one.
- **You may narrow, never redefine.** The freeform argument sets the scope. You may choose which scenarios inside it to work and in which order, and you may drop one with a recorded reason. You may not substitute a different area because the assigned one looked hard, and you may not widen into a neighbouring area because you ran out of ideas — a worker that wanders off its area collides with the worker that owns it.
- **Never run E2E.** `CLAUDE.md` is unambiguous that only a human names an E2E spec or bucket, and there is no human in this run. So this run executes none, and the report says so under Local checks. That is a stated limit, not an oversight.
- **Never ask for approval to continue.** You are pre-authorized for every benchmark in the cluster, every hypothesis, every revert, every measurement, the branch, the commits on it, the push, and the pull request. You are NOT pre-authorized to merge, to touch `develop` directly, or to open a pull request against any base but `develop` — see §Finalization.
- **The pull request is gated on the full unit suite, not on your judgement.** Phase 8 runs `npm test` in full. Red means no pull request until it is green: fix it, or revert the hypothesis that caused it and re-measure without it. "The failure looks unrelated" is a claim to verify against `origin/develop`, not a reason to proceed.

## Inputs — one argument, everything else derived

The whole input is `$ARGUMENTS`. Interpret it, do not validate it.

| What the human typed | What it means |
| --- | --- |
| `PERF-101` | Exactly that benchmark. Cluster of one unless a sibling shares its subject and `--with` or §Cluster pulls it in. |
| `PERF-101 spawnsPerWorktreeN50` | That benchmark and that metric. The target is settled; you still precommit the rest. |
| `the git polling tax`, `secret scrubbing in the logger`, `the resume sweep` | A subject. Resolve to the benchmarks that measure it (§Cluster). |
| `area A`, `--area A` | An area from `AREAS.md`, which holds several clusters. **Pick the one cluster with the best evidence and work only that** — record which you picked, and which you passed over, so the human can run the rest. Never work a whole area in one run. |
| `everything`, `the whole matrix` | Not a run. Pick the single strongest cluster in the matrix on the evidence in `AREAS.md`, say plainly in the report that this was one cluster out of many, and list what a follow-up run should take next. |
| anything else | Read it as a description of what should get faster and resolve it as a subject. |

Flags, all optional: `--with PERF-xxx` (force a named sibling into the cluster), `--budget <Nh>` (wall-clock ceiling, default 8h), `--os local|all` (default `all` — local claim plus the cross-OS count legs), `--no-pr` (commit on the branch and stop before pushing), `--dry-run` (produce the cluster and the precommit records, measure nothing, end at `OPTIMIZE_COMPLETE` with the plan).

Nothing else is asked for and nothing else is waited on.

### Only matrix scenarios

This loop drives `npm run perf <mode> -- --scenario <ID>` and `npm run perf compare`. That is the whole supported surface. The REGISTRY commands are **not** valid targets: `launch-ab` takes `--runs` and packaged-executable operands, `memory-growth` has its own bespoke comparator, `recipe-fanout` is env-var driven, and `interactivity`/`scroll`/`bulk-issue-worktrees`/`memory-pressure`/`cold-start` each have their own shape. None speaks the `--scenario/--json` protocol every gate here depends on. If the freeform argument names one, say so in the ledger, pick the matrix scenario that covers the same subject if one exists, and continue.

## The correctness predicate is mandatory

**A count goes to zero when the feature is broken.** A watcher that never arms spawns no processes. A cache that never writes is infinitely fast. A queue that drops messages has excellent throughput. Every scenario in the matrix declares a `correctness` array naming the miss counts that prove the work happened — `PERF-100` declares `statusPassMisses` and `spawnObserverMisses`, so a `refresh()` rewritten to return immediately shows up as a miss instead of as the best duration the scenario has ever recorded. Read the target scenario's own `correctness` field rather than any list in this document; the roster moves.

Before any measurement, per target:

1. Read the scenario. Take its whole `correctness` array as the predicate set — not a subset you found convenient, and not one you invented.
2. **If it declares none, drop the target.** Record which scenario, and what predicate it would need. Do not add one yourself: a predicate written by the run that optimises against it is worthless, for the same reason a self-graded benchmark is. Move to the next target in the queue.
3. **Confirm a _healthy_ run emits every one of them.** In the Phase 3 probe each predicate must appear in `metricStats` with `count` equal to the aggregate's `runs`. Absent, or present on some iterations only, means you cannot use it — drop the target and say so.
4. **Prove one can fail.** Once per target, at Phase 3: break the subject deliberately on a throwaway commit — make the refresh return immediately, drop the watcher — run three iterations, confirm the predicate goes non-zero, then `git reset --hard` it away. If you cannot construct that break cheaply in ten minutes, proceed and record in the ledger that the predicate is untested evidence rather than proof.

The predicate is an **absolute health condition every round**, not a "did not regress" comparison. A scenario that starts at `detectionMisses: 1` and stays at `1` was broken before you began and stays broken; treating that as passing is exactly the trap.

**The condition is `count === runs` AND `min === 0` AND `max === 0` — all three, every round.** `MetricStat.count` is the number of iterations that _emitted_ the metric, not the number that ran, so a predicate that vanished for fourteen of fifteen iterations still aggregates to `max: 0` and reads as perfect health. And `max === 0` is not "every sample was zero": some predicates are signed subtractions where a negative means the subject produced _more_ than it was asked to, so a run of `[-1, 0]` has a max of zero and a full count while being plainly unhealthy. `check-pair.mjs` applies all three; do not simplify it back.

**An improvement with the predicate unhealthy is a bug, not a win.** Revert it, record it, move on. Do not try to repair it in the same round.

## Core rules

- Work on one branch cut from `origin/develop`, named `perf/optimize-<area-or-subject>`. Never optimise on `develop` or `main`, and never in the main worktree when this session has its own.
- **Measure before changing anything.** No before measurement means no table and no run.
- **Write the decision down before the measurement that judges it.** `precommit.mjs` per target, before the baseline. See §Precommit.
- **One hypothesis per round.** Two changes means you cannot attribute the result and will keep the wrong one.
- **Compare each round against the current best, not the baseline.** Judging against the baseline keeps a hypothesis that made the best result worse, so long as it still beats where the run started.
- **No claim on a machine-dependent metric without a fresh interleaved arm.** A stored file measured hours ago is not an opponent; it is a record of a different thermal state.
- **Revert on the evidence, not the story.** A plausible mechanism is not a measurement.
- **Never touch any measurement surface.** Not the scenario, not its fixture, not `scripts/perf/lib/`, not `budgets.json`, not the protocol flags, not the scripts beside this file. The apparatus hash in the precommit record enforces this — a claim measured against an edited harness fails the gate rather than reading as a win. The final diff must contain **no** changes under `scripts/perf/`; Phase 8 verifies it.
- Keep the branch focused. No unrelated cleanup, no dependency bumps, no drive-by refactors, no documentation passes.
- Do not modify user-owned agent config (`~/.claude`, `~/.codex`, `~/.gemini`, shell hooks).
- Read `CLAUDE.md`, `.claude/rules/perf-benchmarks.md` and `.claude/rules/testing.md` before touching production code. A faster app that breaks an architectural invariant is not shippable.

## The ledger

`.tmp/optimize/ledger.md` is the durable state of the run and the first thing to re-read after any loss of place. `.tmp` is gitignored; never commit it.

It holds, and is updated at every phase transition:

- The freeform argument as given, and the queue derived from it with the reason for each entry and each rejection.
- Branch name, branch-point sha (the **baseline sha**), and the current **champion sha**.
- Per target: the precommit record path, the before numbers, the hypothesis log (number, change, verdict, why), and the local claim.
- Which phase and which target the run is on, and what has already been re-measured in Phase 6.

The shas are not bookkeeping. They are the only thing that ties a measurement file to the code it measured once the conversation has been compacted twice and every JSON in `.tmp/opt/` has a plausible-looking name.

## Progress

**Your position line is your progress state.** Every transition opens with `Phase N/10 {name} verified. Benchmark {k}/{M} {scenario} {metric}. Next: {M}/10 {next}.` If you lose your place, scan back for the most recent position line, cross-check the ledger, and continue from there. Do not build a separate task list — §Pipeline already holds the phases in order.

Phases 3, 4 and 5 cycle once per benchmark in the cluster. While cycling, hold the position line at the phase you are in and carry the benchmark counter; only advance past 5 when every member of the cluster has been worked.

## Pipeline

| # | Phase | What happens | Exit condition |
| --- | --- | --- | --- |
| 1 | Intake | Parse `$ARGUMENTS`, preflight the tree, fetch, branch from `origin/develop`, create the ledger, record machine identity and which OS legs are reachable | Clean tree, branch exists, ledger written |
| 2 | Cluster | Resolve the ask to one benchmark or a same-subject handful, with a recorded reason per member and per rejection (§Cluster) | 1..4 benchmarks in the ledger, all sharing one subject |
| 3 | Precommit & baseline | Per benchmark: probe, choose target metric + full predicate set + guards, run `precommit.mjs`, prove a predicate can fail, measure the baseline (§Precommit, §Measure) | `precommit.json` written, `before.json` healthy and non-degenerate |
| 4 | Hypothesis loop | Per benchmark: one hypothesis per round, commit before measuring, gate, keep or revert (§Loop) | Budget spent, or credible hypotheses exhausted |
| 5 | Local claim | Per benchmark: fresh interleaved A/B of its own baseline sha against the current tree (§Claim) | `CLAIM`, `NO CLAIM`, or a recorded `NO MEASUREMENT` retry. More cluster members → back to 3 |
| 6 | Cluster close | **Squash first**, then re-measure **every** benchmark in the cluster — kept, unmoved, and the ones you never formed a hypothesis for — against the branch point, on the squashed tree (§Cluster close) | Every member has a final number measured on the tree that ships |
| 7 | Cross-OS legs | Dispatch `perf-ab.yml` for every count/size/ratio target; durations get no CI claim (§Cross-OS) | Legs reported, or a recorded reason there are none |
| 8 | Prove the tree | `npm run typecheck`, **the full `npm test`**, `npm run check`, and the diff audit proving nothing under `scripts/perf/` changed (§Prove the tree) | All green. **Hard gate on phase 9** |
| 9 | Pull request | Push the branch and open the PR against `develop` with the evidence in the body (§Finalization). The squash happened before phase 6 — a rewrite here would orphan every number phase 6 measured | PR URL captured — or skipped, with the branch deleted, when nothing improved |
| 10 | Report | Per-benchmark and per-machine tables, hypothesis ledger, PR link (§Report) | Ends with `OPTIMIZE_COMPLETE` |

Emit a transition after every phase: position line, what you learned, decision, then start the next phase **in the same turn**.

## §Cluster

The ask becomes 1–4 benchmarks. More than four is not a cluster, and the fourth is usually already a different subject.

**Admission test, applied to every candidate after the first: does one plausible fix move both?** `PERF-100` (git status pass, clean worktree) and `PERF-103` (the same pass, dirty worktree) pass it — they run the same code over different inputs. `PERF-100` and `PERF-382` (the logger's secret scrubber) fail it: both are main-process cost, neither shares a line of code with the other. Sharing an area in `AREAS.md` is not the test; sharing a subject is.

To resolve a subject to benchmarks:

1. `rg -n "<subject words>" scripts/perf/scenarios/` and read the matching scenario definitions — `name`, `description`, `correctness`, and the fixture header, which states the scope limits in full.
2. Cross-read `scripts/perf/README.md`. Several families have a "the one to watch" or "the number to read" paragraph naming the finding the family was built around; that paragraph is usually the target.
3. Check `AREAS.md` for the recorded evidence and the suggested entry point. Its rows are **families**, not clusters — several run to six or nine scenarios. Take the entry target plus at most three siblings that one fix would move; leave the rest and name them in the report.
4. Rank candidates by **evidence of headroom**, not by size of number: a benchmark with a named mechanism in the README beats a big p95 with no explanation. An idle-window scenario's p95 is a fixed observation window by design and is never the target — its counts are.

Then write the cluster into the ledger with, per member: the scenario id, why it is in, and the metric you expect to target. And write the rejections: what you considered and why it is a different subject. That list is what stops a later round quietly widening scope.

**Drop a member, with a recorded reason, when:** it declares no `correctness` array; its predicates are not emitted on every iteration of a healthy probe; its target metric is degenerate (a zero, which usually means the scenario measured nothing); or one arm at the protocol you need costs more than fifteen minutes and the target is a duration — see §Budget arithmetic.

## §Precommit

Per benchmark, before the baseline, and never after a number exists.

The old form of this skill made a human name the metric, the predicate, the guards and the threshold. That was friction with one real purpose: those terms were fixed before any number was on screen. Deriving them is fine — they are in the scenario definition and the probe. Deriving them _after seeing which one moved_ is the failure the whole loop exists to prevent. So the derivation is written once, to a file that refuses to be rewritten.

**Precisely when.** After the probe and before the baseline. The probe measures the champion tree alone: it tells you which metrics exist, which are non-degenerate, whether the predicates are emitted on every iteration, and how much this machine drifts — all facts about a tree you have not changed yet. It cannot tell you which hypothesis will win, and that is the only thing the lock protects against. The gate enforces the ordering rather than trusting it: every arm's `generatedAt` must be later than the record's `createdAt`, so measuring first and locking afterwards fails instead of passing.

**Derive, in this order:**

1. **The target metric.** One scalar that can go down (or up, with `--higher-is-better`). Prefer, in order: a `count`, a `size`, or a structural `ratio` from the scenario's own metrics; then `p50Ms`; then a per-operation duration the scenario reports. **Never a `p95Ms`, `p99Ms` or `maxMs`** — `precommit.mjs` refuses those below 59 iterations because covering the 95th percentile with 95% confidence needs `ln(.05)/ln(.95) ≈ 59` samples and a p99 needs ~299. Below that a p95 is the second-largest reading with a percentage printed next to it. Prefer a deterministic class when the scenario offers one: it needs no interleaved A/B, no threshold you have to defend, and it is the only class the cross-OS legs can claim.
2. **The predicate set.** The scenario's entire `correctness` array. Not a subset.
3. **The guards.** Every other metric the scenario emits, passed as `--guard <name>:<tolerance>`. Tolerance by class: **10%** for `duration`, `memory`, `derived-ratio`; **5%** for `count`, `size`, `ratio`. These are enforced, not advisory — `check-pair.mjs` makes a breach its fourth condition. A guard you do not precommit is a cost nobody is watching for, and the verdict says so explicitly when the list is empty.
4. **The threshold.** The minimum improvement you will call real. For a deterministic target, 1%. For a machine-dependent target, `max(5%, 2 × the drift you saw in the probe)`. Precommit it; do not revisit it.
5. **The protocol.** Mode from the scenario's own `modes` (prefer `smoke` while iterating). Iterations: 5 for a deterministic target, 20 for anything else. Warmups: the scenario's own default unless it has none, then 3.

Then:

```bash
node .agents/skills/optimize/precommit.mjs \
  --dir .tmp/opt/<PERF-ID>-<metric> \
  --scenario <ID> --target <metric path> \
  --predicate <each one> \
  --mode <mode> --iterations <N> --warmups <W> \
  --statistic <median|count> --threshold <pct> \
  --baseline-sha $(git rev-parse HEAD) \
  --guard <name>:<tolerance> ...
```

It prints the record and the apparatus hash, and refuses to overwrite an existing one. **That refusal is the point** — if the target genuinely has to change, the first decision is a disproof worth reporting: start a new `--dir`, and say in the report why the first was abandoned.

Pass `--precommit <that file>` to every `check-pair.mjs` call afterwards. It re-checks the target, the direction, the predicate set, the threshold, the mode, the iterations and the warmups against the record, and re-hashes `scripts/perf/` plus the gate scripts. A run that edits a benchmark to make it measure less now fails the gate instead of reading as a win.

## §Measure

Every measurement in this run uses the same command shape, and any difference in it is a difference `perf compare` will report as though it were a difference in the code.

```bash
npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label <name> --json .tmp/opt/<dir>/<name>.json
```

The baseline is the run's first champion, so Phase 3 ends by making that explicit:

```bash
npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label before --json .tmp/opt/<dir>/before.json
cp .tmp/opt/<dir>/before.json .tmp/opt/<dir>/best.json
```

`best.json` is what every round is judged against, and it is only ever a copy of a measurement that was actually taken — on KEEP, `cp .tmp/opt/<dir>/h<k>.json .tmp/opt/<dir>/best.json` and record the new champion sha beside it. A `best.json` whose `sourceSha` is not the champion sha is stale by definition: discard it and re-measure rather than reasoning about which tree produced it.

Use `.tmp/opt/` for every artifact — `/tmp` is not portable to Windows, and the harness creates parent directories.

**Machine hygiene, before the first arm and between every pair:**

- Nothing else running: no build, no dev server, no other agent, no `npm install`. Abort and redo a whole interleave if something started mid-measurement — never replace one contaminated arm and keep its partner, which reintroduces exactly the pairing the interleave exists to prevent.
- Plugged in, low-power mode off.
- On macOS, hold the machine awake for the duration with `caffeinate -dimsu <command>`; a nap between arms is drift you introduced. Do **not** reach for `taskpolicy -c` — its clamp only lowers QoS (`user_interactive` is not even a parseable value, and `-c utility` would push the work onto efficiency cores, which is the opposite of what you want). Apple Silicon exposes no frequency pinning and no core affinity, so an idle machine is the whole of the lever.
- Leave a few seconds between arms. Back-to-back arms accumulate heat, and the first arm of a session is always the coldest — which is why the A/B recipe reverses the middle pair.

**Reading the run:** a `measurement-issues=` non-zero in the header, or a compare warning about a count no longer emitted or a count falling to zero, describes the dead-watcher shape, which looks identical to success. Read them.

### Budget arithmetic

Derive the budget rather than guessing it. Time one baseline arm, then:

- A deterministic target costs: probe + baseline + one arm per hypothesis + 2 arms to confirm + 2 arms for the headline. Roughly `hypotheses + 6` arms.
- A machine-dependent target costs: probe + baseline + one arm per hypothesis + **6 arms** per confirming A/B + **6 arms** for the headline. Roughly `hypotheses + 14` arms, and the confirmations dominate.

If one arm at the precommitted protocol exceeds ~15 minutes and the target is a duration, **switch to that scenario's count target instead** and record the swap. `PERF-092`/`093`/`094` run 20–24 seconds per iteration: a 20-iteration arm is seven minutes and a six-arm A/B is three quarters of an hour, so their durations are not optimisable inside any sane budget and their spawn counts are.

Reserve the last of the budget for phases 6, 8 and 9. A run that spends everything on hypotheses cannot prove the tree is green, cannot open a pull request, and has produced nothing usable. Stopping a hypothesis short to protect that reserve is the right call.

## §Loop

Repeat per benchmark until the budget for it is spent or credible hypotheses run out.

1. **Form one hypothesis.** Name the mechanism and where it lives. "This looks inefficient" is not a hypothesis; "`GitStatusPass` re-stats every file because the gitDir is null, so the cheap path is never taken" is. Read the code first. Use Codex (`mcp__codex__codex`, `model: "gpt-5.6-sol"`, `model_reasoning_effort: "max"`, `sandbox: "read-only"`, explicit `cwd`) for a second opinion on the mechanism when the code is unfamiliar — a self-contained prompt naming the files by path.
2. **Make the smallest change that tests it, and commit it before measuring it.** Not the prettiest fix — the smallest one that moves the named mechanism. Every measurement is of a committed tree: an uncommitted change leaves `sourceSha` naming the champion commit while the code being measured is something else. `git status --porcelain` must be empty when a measurement starts.
3. **Re-measure with the identical protocol, then gate the pair before reading any number in it:**

```bash
npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label h<k> --json .tmp/opt/<dir>/h<k>.json
node .agents/skills/optimize/check-pair.mjs --scenario <ID> --target <metric path> \
  --predicate <each> --precommit .tmp/opt/<dir>/precommit.json \
  [--higher-is-better] \
  --expect-before-sha <champion sha> --expect-after-sha $(git rev-parse HEAD) \
  .tmp/opt/<dir>/best.json .tmp/opt/<dir>/h<k>.json
npm run perf compare .tmp/opt/<dir>/best.json .tmp/opt/<dir>/h<k>.json
```

4. **Act on `check-pair.mjs`'s exit code — `perf compare` and `run` exit 0 on every one of these:**
   - **1** → the pair is not a result. Protocol, machine, mode or selection mismatch; a `sourceSha` that is not the tree you think you measured; a toolchain version move; a broken apparatus; an unhealthy or under-emitted predicate; a precommit term that does not match; an edited harness. Do not read the comparison. Fix the cause and re-measure.
   - **2** → the command line was wrong, so nothing was judged. Fix the invocation.
   - **3** → no `sourceSha`. Proceed only if you measured both arms in this session, interleaved, and say so in the report.
   - **4** (`ab` only) → the arms were sound and the hypothesis lost. Revert and record a disproof. Not a run to retry with more pairs: extending after an unfavourable number is the same fallacy as re-choosing the threshold.
   - **5** (`ab` only) → champion drift exceeded the ceiling: the machine could not resolve a difference this size. **Not a disproof.** Do not revert on it. Cool the machine, close whatever is running, measure the same pair again. If it will not settle, raise the iterations or record that this target cannot be measured here.
   - `REFUSED` in `perf compare` → the comparison did not happen for a reason `check-pair.mjs` did not predict. Stop and find out what.
5. **Check the predicate** on the round's own JSON. Unhealthy → revert, record, next hypothesis.
6. **The guards are checked for you.** `check-pair.mjs` reads them out of the precommit record and rules on them as its fourth condition, so a change that wins its target and doubles the metric beside it is a `NO CLAIM` (exit 4) rather than a green table. Guards are cost metrics — up is worse — and machine-dependent ones are judged against the same drift **D** as the target, because a guard that moved less than D has not been _shown_ to move. To keep a deliberate trade, name it: `--allow-guard-regression <name>` on the command line that produces the verdict, and justify it in the report. Accepting it any other way is accepting it after seeing the number.
7. **Decide:**
   - Improvement over **best**, predicate healthy, guards inside tolerance → confirm it reproduces. For a `count`, `size` or `ratio` one clean re-measurement is enough. For anything else run the paired A/B in §Claim. Then KEEP: the `h<k>` commit becomes the new champion and `best.json` its measurement.
   - No movement, or inside the noise → REVERT with `git reset --hard <champion sha>`. Record the disproof; it has value.
   - Regression → REVERT.
8. **Run the tests covering every file you touched** before the next round, via §Checks. A round that breaks a test and moves on compounds, and phase 8 will make you find it later at much greater cost.
9. Update the ledger. Go again.

## §Claim

Anything that is not a `count`, a `size` or a structural `ratio` is the weakest thing this harness measures and the easiest to lie with — durations, memory readings, and the `derived-ratio` class that looks normalised and is not.

**A stored `best.json` is not an opponent.** Over a multi-hour run the machine heats, background load shifts, and a champion measured cold at hour zero loses to nothing at all by hour four. Selecting the best-looking of twenty hypotheses against that file is selecting on drift. So both arms are measured now, alternating, and the claim is made against the arm you just measured.

Both trees must already be commits, because `sourceSha` is what proves each arm measured what it says it did.

```bash
BRANCH=$(git branch --show-current); CHAMP=<champion sha>; CAND=$(git rev-parse HEAD)
arm() { git switch --detach "$1" && npm run perf <mode> -- --scenario <ID> --iterations <N> --warmups <W> --label "$2" --json ".tmp/opt/<dir>/ab/$2.json"; }
arm "$CHAMP" champ1 && arm "$CAND" cand1
arm "$CAND" cand2 && arm "$CHAMP" champ2
arm "$CHAMP" champ3 && arm "$CAND" cand3
git switch "$BRANCH"
```

Three pairs minimum, uninterrupted. Never all-champion-then-all-candidate: that arrangement cannot separate your change from the hour that passed. The middle pair reverses because the first arm of a session is the coldest, and a fixed order hands that handicap to the same side three times. Pass `--iterations`/`--warmups` on every arm — an arm that lets the scenario pick its own counts is not the same measurement as the one beside it.

None of that shape is on your honour:

```bash
node .agents/skills/optimize/check-pair.mjs ab --scenario <ID> --target <metric path> \
  --predicate <each> --precommit .tmp/opt/<dir>/precommit.json \
  --threshold <precommitted %> --max-cv 10 [--higher-is-better] \
  --expect-champ-sha "$CHAMP" --expect-cand-sha "$CAND" \
  --champ .tmp/opt/<dir>/ab/champ1.json --champ .tmp/opt/<dir>/ab/champ2.json --champ .tmp/opt/<dir>/ab/champ3.json \
  --cand .tmp/opt/<dir>/ab/cand1.json --cand .tmp/opt/<dir>/ab/cand2.json --cand .tmp/opt/<dir>/ab/cand3.json
```

It reconstructs the running order from the arms' own `generatedAt` stamps and refuses three champion runs followed by three candidate ones, an order that never reverses, arms passed out of measurement order, repeated or copied arms, and any arm whose `sourceSha` is dirty or is not the tree you named. Then it rules on four conditions: the candidate won **every** index-paired arm; the median-to-median improvement met the precommitted threshold; it exceeded the champion-versus-champion drift **D**; and no guard from the precommit record moved outside its tolerance. Pass `--champ`/`--cand` in measurement order, oldest first. `--higher-is-better` must match the precommit record — the gate compares the two and fails a mismatch, because a direction flipped after the fact turns every regression into a win.

For the Phase 6 headline, add `--headline`: it asserts that the champion arms were measured at the **branch point** the record names, which is the one comparison that must not be against a mid-run tree.

**Why unanimity plus a threshold plus D, rather than a significance test.** Three pairs is all the arms a multi-hour budget affords, and at n=3 no test has the power to separate a 5% effect from noise; requiring all three pairs to agree in direction is a sign test at the strongest level three pairs can reach, and D is a measured noise floor rather than an assumed one. That is honest about what three pairs can support. It is also why the loop leans so hard on deterministic targets, where none of this is needed.

**On the multiple-comparisons problem.** A run that tries fifteen hypotheses at a 5% threshold will find one or two that clear it by luck. The correction is structural rather than statistical: **the number in the report never comes from the round that selected the hypothesis.** It comes from the phase 6 re-measurement of the final tree against the branch point, run once, after all selection is over. A change kept on a lucky round and re-measured there will not survive.

### Everything else about durations

- **p95 at low iteration counts is one of the two largest samples, not a tail estimate.** `perf compare` leads with the median for that reason. `precommit.mjs` refuses a tail target below 59 iterations.
- `perf compare` is **descriptive** — no confidence interval, no significance test. If you cannot defend a threshold, **report the raw before/after numbers with no percentage claim.** That is honest; a percentage you cannot defend is not.
- Never delete inconvenient outliers after seeing them.

## §Cluster close

After the last code change, and before the tests.

Every number measured earlier in the run belongs to a tree that no longer exists: a fix found for the third benchmark changed the code the first one was measured on, which is exactly why the cluster is same-subject in the first place — one fix is _supposed_ to move all of them.

So, on the final tree, for **every** member of the cluster including the ones you never formed a hypothesis for:

- Run the full paired A/B of the **branch point** against the final tree, at that member's own precommitted protocol, with its own `precommit.json`. For a deterministic target one clean pair suffices; for anything else the six arms above.
- A member you never touched can come back **worse**. That is a real finding and it goes in the report as a row, not a footnote. If it is outside its own guard tolerance, treat it as a regression: revert the hypothesis responsible and redo this phase.
- These are the only numbers the report is allowed to quote.

If a headline A/B does not meet all four conditions, **the improvement was not real.** Reset the branch, report the headline numbers, and say the intermediate rounds over-read the noise. That verdict will feel wrong after hours of work on a change you can explain — the mechanism being plausible is what made it worth testing, and is not evidence that it worked.

## §Cross-OS

An improvement measured on one machine is a claim about one machine. Local first, always, and to a finished claim — the other legs verify a result, they do not search for one.

**Local legs.** If this session can reach another physical machine, re-measure the final tree there against **that machine's own before file**, same protocol. `perf compare` refuses a cross-machine machine-dependent comparison and the refusal is correct: each machine gets its own before/after pair and its own percentage. If a leg needs a machine you cannot reach, say so and mark it not measured.

**GitHub legs — counts, sizes and ratios only.** `.github/workflows/perf-ab.yml` measures both trees in one job on one runner and gates the result with `check-pair.mjs ab --cross-machine`, which refuses any target that is not machine-independent.

```bash
gh workflow run perf-ab.yml --ref "$(git branch --show-current)" \
  -f base_sha=<branch point> -f cand_sha=<final sha> \
  -f scenario=<ID> -f target=<metric path> -f predicates=<comma separated> \
  -f mode=<mode> -f iterations=<N> -f warmups=<W> -f threshold=<pct> \
  -f higher_is_better=<true|false> -f os=all

# Dispatch returns nothing useful, so correlate the run yourself and WAIT.
# Filter by branch: several workers dispatch this workflow at once, and a bare
# `--limit 1` cheerfully returns whichever of them started most recently.
BRANCH=$(git branch --show-current); SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN=$(gh run list --workflow=perf-ab.yml --branch "$BRANCH" --event workflow_dispatch \
  --created ">=$SINCE" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status || true
gh run view "$RUN" --log | grep -E "VERDICT:|check-pair exit|::error"
```

**Do not dispatch and walk on.** A leg that is still queued when Phase 9 opens the pull request contributes nothing but a claim in the report that nobody checked. Wait for each leg, read its verdict, and record it. A leg that comes back `NO MEASUREMENT` (exit 5) is re-dispatched once; if it will not settle, record it as not measured rather than as a failure. A leg that comes back `NO CLAIM` (exit 4) is a finding: the improvement did not reproduce on that platform, and the report says so per platform rather than averaging it away.

**Never claim a duration off a hosted runner, whatever the workflow reports.** Hosted runners vary 5–25% run to run; `rustc-perf`, V8, Node core and bencher.dev all refuse shared cloud CI for wall-clock work, and CodSpeed replaces the clock with instruction counting rather than trusting it. Two arms in one job share a VM, which is why the deterministic classes are sound there — the counts are the same counts — but the clock is not.

**Read a cross-OS count difference carefully.** An _absolute_ count that differs between platforms is usually platform semantics, not a regression: Windows wraps shell execution in `cmd.exe`, so spawn counts are inflated relative to POSIX; file watching is `inotify` on Linux, `FSEvents` (directory-aggregated) on macOS and `ReadDirectoryChangesW` on Windows, so event counts for the same file mutation differ by design. What travels is the **before→after delta on each platform**, each measured on that platform. "macOS 16 → 2, Windows 34 → 20" is the claim; "Windows is 34 and macOS is 16" is a finding for an issue, not for this report.

An improvement on one OS and not another is a finding worth reporting, not a failure to hide.

## §Prove the tree

Phase 8, and a hard gate on the pull request. Delegate every one of these to a §Checks agent.

1. `npm run typecheck` — never a bare `tsc -b`, which emits build artifacts and phantom TS6305s outside the wrapper.
2. **`npm test` — the full suite, not a subset.** Scoped runs have repeatedly hidden failures here and cost a CI round trip. This is the gate the pull request depends on.
3. `npm run check` if anything touched types, IPC, keybindings, plugin manifests, or lint-visible code. `prettier` prints "All files formatted correctly" while exiting 1 — trust the exit code.
4. `git diff --name-only` against the branch point, and audit it twice:
   - **Nothing under `scripts/perf/`.** The apparatus hash already refuses a claim measured against an edited harness, but the diff is what proves it to a reader.
   - **Nothing outside your area's owned paths** in `AREAS.md`. That partition is the only thing keeping concurrent workers from colliding, and it is not enforced anywhere else. A file you had to touch that no area lists is a real finding: name it in the report so the partition can be corrected, rather than silently claiming ownership of it.

If a test fails, reproduce it narrowly and decide whether it is a real break from your change or a known flake (`.claude/rules/testing.md`: a worker crash after all tests pass is a flake; a teardown-timer failure naming a new file is real). Confirm a "looks unrelated" failure against `origin/develop` before believing it.

**A real break you caused:** fix it, then rerun the full suite. If you cannot fix it, revert the hypothesis that caused it, redo §Cluster close without that hypothesis, and rerun. Only when neither is possible does the run finalise as **blocked** with the branch left in place. There is no path where a red suite becomes a pull request.

**A failure already red on `origin/develop`** is not yours and not a blocker. Prove it — run the same test against `origin/develop` and confirm it fails there too — then name it in the report and proceed to the pull request. The base is broken independently of this work and CI re-runs it before anything lands. Do not fix code outside your cluster to go green: that is the scope widening §Autonomy forbids, and it collides with whichever worker owns that area.

**An outage rather than a defect** — `gh` unauthenticated, GitHub unreachable, a push rejected for a reason no rebase fixes — is a legitimate `OPTIMIZE_BLOCKED`. Commit everything, leave the branch, and say exactly which step could not run.

Cap at 3 fix iterations. Carry the counter in your text (`prove 2/3`) so a compacted summary keeps it.

**When, and only when, all four are green:**

```bash
git rev-parse HEAD > .tmp/optimize/tests-green
```

That file is the receipt, and it is not paperwork: a `PreToolUse` hook reads it and **denies `gh pr create`** unless it holds the current HEAD. So the gate does not depend on you remembering the rule at hour six, and it re-arms itself against exactly the mistake that matters — any commit, squash or amend after Phase 8 moves HEAD, the receipt stops matching, and the pull request is refused until you re-run the suite and redo §Cluster close against the tree that actually ships.

Never write the receipt ahead of the run, and never for a suite you did not watch finish.

**Be clear about what that hook is.** It matches the literal PR-create command, so it stops the ordinary mistake — reaching phase 9 without having run phase 8, or opening the PR after a squash moved HEAD. It does not stop a determined agent: a different spelling of the command, the REST API, or simply writing the receipt by hand all get past it, and nothing in this loop can catch a fabricated receipt. It is a guard against forgetting, not against dishonesty. The same is true one level down: `check-pair.mjs` reads the summary files the runner wrote and cannot tell a real measurement from a hand-edited one. Every gate here raises the cost of fooling yourself by accident. None of them makes it impossible on purpose, and a report that says otherwise is overclaiming.

## §Checks

**Delegate every verbose check command to a Haiku subagent.** Never run tests, typecheck or lint inline in this context — the output is large and this run is long.

```
Agent:
  subagent_type: general-purpose
  model: haiku
  description: "Run {check} and report failures"
  prompt: |
    Run this command: {full command}
    Return ONLY this format — no narration:
      If clean: "PASS ({short note, e.g. '4218 tests', 'no errors'})"
      If failed, one block per failure:
        FAIL
        Tool: {vitest | tsc | eslint | prettier}
        File: {path}:{line}
        Error: {first error line}
        Context (first 3 lines, if relevant)
    Do not include passing items.
```

Foreground only — you need the verdict in this turn. Never spawn a duplicate agent for a command that already has one running, and never spawn background waiter shells: they leak past the session.

The perf runs themselves are **not** delegated. They must run in this session, on this machine, with nothing else competing — a subagent measuring in parallel with anything else is the contamination the whole protocol is built against.

## §Fixing guidelines

- **Fix the mechanism, not the symptom.** Caching a slow call is sometimes right and sometimes hides that the call should not happen — #12042 was caused by a cache doing exactly that.
- **Watch for moving work rather than removing it.** Ten spawns becoming one resident daemon is a 90% win on the spawn count and may be worse overall. That is what the guards are for.
- **Do not make the benchmark's inputs easier.** Specialising on a fixture's shape, memoising on a key the fixture happens to hold constant, or short-circuiting a path the fixture never exercises are all wins that evaporate in production. If a change would not help a user, it is not an optimisation whatever the number says.
- Respect the product invariants in `CLAUDE.md`. Never modify user-owned agent config for speed. Never trade an observation for an interpretation — `running` is a runtime status, not an agent state.

## §Finalization

Three outcomes. The first two are complete, correct runs.

### Nothing improved

`git reset --hard <branch point>`, confirm `git status --porcelain` and `git diff origin/develop` are both empty, then `git switch --detach <branch point>` before `git branch -D <branch>`. Git refuses to delete the branch you are standing on, and plain `git switch develop` fails here too — this run works in a linked worktree and `develop` is checked out in the main one. A run that ends holding a branch it said it deleted has lied in its own report. **No pull request, no commit to `develop`, never an empty or marker commit.** The evidence is the report: the target and its before value, every hypothesis with the measured reason it was rejected, and what you would try next or why you believe the number is at its floor.

### Something improved

Only after phase 8 is fully green.

1. Squash the kept commits into one focused commit per benchmark, or one for the cluster when a single fix moved all of them. Conventional-commit subject, `perf(<scope>): <what>`.

   **Squash before Phase 6, not here, and redo Phase 6 if Phase 8 changed anything.** Squashing rewrites the sha, so a headline measured at the old sha names a commit the pull request does not contain. The order that keeps the report honest is: finish the hypotheses, squash, §Cluster close against the squashed tree, then Phase 8. If Phase 8 forces a code change — a test fix, a revert — that tree is no longer the one Phase 6 measured, so **redo §Cluster close** before opening the pull request. A tidy history is not worth a table naming a tree nobody can check out.

2. `git push -u origin <branch>`, then `gh pr create --base develop` — **never `main`**.
3. The PR body carries the evidence: the per-benchmark table from §Report, the machine line, the hypothesis ledger including the rejections, and an explicit statement of what was **not** measured (no E2E, which OS legs are missing and why). Write it in Greg's voice — invoke the `greg-priday-writing` skill if this runner exposes it, and otherwise write plainly and directly yourself rather than stalling on a skill that is not there.
4. **No AI attribution anywhere** — no `Co-Authored-By`, no generated-by footers, no mention in the PR description.
5. Do not merge. Leave the PR for the human.

`--no-pr` stops after the commit and reports the branch name instead of a URL.

### Blocked

A test failure your change caused that you can neither fix nor revert, or a harness that will not run. Leave the branch, report the failing test, the narrowest reproduction, and which hypothesis introduced it. End with `OPTIMIZE_BLOCKED`.

## §Report

Phase 10. One block per benchmark per machine — never merge two machines into one table.

```
## <scenario> <metric path> — <machine label>

| Metric                  | Before | After | Change |
| ----------------------- | -----: | ----: | -----: |
| <target metric>         |     16 |     2 | −87.5% |
| <correctness predicate> |      0 |     0 |     ok |
| <guard metric>          |    412 |   418 |  +1.5% |

Machine: <label> (<platform>/<arch>) · mode <mode> · <N> iterations · <W> warmups
Trees: <branch point> → <final sha> · git <version> · Electron <version>
Statistic: <median|count> · precommitted threshold: <value> · measured drift D: <value|n/a>
```

- Both numbers come from **§Cluster close**, not from any file measured earlier in the run. Paste `check-pair.mjs ab`'s verdict block verbatim below the table: it carries D, the per-pair results and the threshold the tool actually used, so the report cannot quote a threshold it was not given.
- The predicate is always a row, reading `ok` only when `count === runs`, `min === 0` and `max === 0` on both sides — all three, the same terms the gate applies. A reader must see that the feature still works **and** that the check was taken.
- Every guard is a row, including ones that moved the wrong way.
- Percentages only where the comparison is legitimate — never across machines for anything outside `count`, `size` and `ratio`, and never on a machine-dependent metric whose threshold you did not precommit or whose improvement did not exceed D.
- Below the tables: the hypothesis ledger, one line each, including the rejected ones. The rejections are most of the value.

Then the final summary, ending with the sentinel:

```
✅ **Optimize complete** — <subject>

📊 **Cluster**: <scenario ids> — <one line on the shared subject>
📈 **Result**: <headline, or "no improvement was available">
🧪 **Predicates**: all healthy across <N> benchmarks
🖥️ **Machines**: <local label> (full) · <OS legs, counts only> · <what was not measured>
🏗️ **Tree**: typecheck ✓ · full vitest ✓ (<N> tests) · check ✓ · no diff under scripts/perf ✓
🚫 **E2E**: not run — only a human names a spec
🔗 **PR**: <URL, or "none — nothing improved">

OPTIMIZE_COMPLETE
```

## §Distribution

`AREAS.md` partitions the whole matrix into five areas, each listing its clusters, its recorded evidence, and its owned source paths.

To run a fleet: give each worker **one area**, on its own machine, in its own worktree. The worker picks the strongest cluster in that area, runs this skill end to end, and opens one pull request. Areas are partitioned by owned source path, so two workers on two areas do not edit the same files and their pull requests do not conflict; a worker that widens outside its area breaks that guarantee, which is why §Autonomy forbids it.

Workers never coordinate. Each one's output stands alone: a branch, a pull request, and a report whose numbers were measured on that worker's own machine and named with that machine's label. A second run against the same area later picks the next cluster, which the previous report named.

## Related

- `precommit.mjs` — writes the decision before the numbers exist, and refuses to be rewritten after them.
- `check-pair.mjs` — the pre-compare gate, and the only exit code in this loop worth acting on.
- `harness-digest.mjs` — hashes the measurement apparatus so an edited benchmark cannot be claimed against.
- `metric-class.mjs` — which metrics survive a cross-machine comparison. A mirror of `scripts/perf/lib/comparability.ts`, pinned to it by `scripts/perf/__tests__/optimizeMetricClass.test.ts`.
- `AREAS.md` — the five areas, their clusters, and the recorded evidence for each.
- `scripts/perf/README.md` — the harness, its modes, and every `npm run perf` command.
- `.claude/rules/perf-benchmarks.md` — never add a `perf:*` script; baselines are local and per-machine.
- `.claude/rules/testing.md` — the E2E contract. Only a human names a spec, so this run names none.
- `.agents/skills/stabilize/` — whole-tree, all-OS validation. Different job: stabilize proves the tree is green, optimize moves one number.
