---
name: stabilize
description: Drive Daintree to a fully green, stable state across every check we can run — typecheck/lint/format, unit, integration, knip, build, smoke, and the full Playwright E2E surface (core, all seven full-* buckets, online, and the nightly memory-leak soak). Local-first and strictly serial by OS: run everything on the local Mac (macOS) to green first, then dispatch the cross-platform `stabilize.yml` GitHub workflow one OS at a time — Linux to green, then Windows to green — fixing real failures and intelligently re-running flaky E2E at each stage (plus release dry-runs when releasing). Never run Linux and Windows in parallel; a bug caught on Linux that also breaks Windows would waste an expensive Windows run. Designed to run overnight. Use before a release, or every few days to keep the tree healthy. Invoke with "Please stabilize using the stabilize workflow."
---

# Stabilize

Drive the Daintree tree to green and keep it there. This is the replacement for the old scheduled nightly: instead of a dumb cron that runs everything once and opens a low-signal `[Nightly] Tests failed` issue every time an E2E flake trips, an agent runs the whole surface, reads the results, tells flakes apart from real regressions, re-runs intelligently, fixes the real failures, and only reports when the work is actually done. Treat this as a durable, multi-hour, overnight loop. The work proceeds strictly one OS at a time — macOS (local) → Linux (CI) → Windows (CI) — each driven fully green before the next begins, so no GitHub runner time is wasted re-discovering a failure an earlier stage would have caught. All the work happens on a dedicated stabilize branch off `origin/develop`. The job is complete only when the full local gate is green AND `stabilize.yml` has passed for Linux and then Windows on the branch (plus release dry-runs when stabilizing for a release) AND — if any fixes were made — they have been squashed into a single commit, merged into `develop`, and pushed to origin, with the working tree left back on `develop`. A run that needed no fixes commits nothing and simply deletes its branch. See **Finalization** for both close-out cases and their "done means" checklists.

There is no issue-creation step anywhere in this flow. You are the triage. Do not open or update a `nightly-failure` issue — that mechanism was retired with the scheduled nightly.

**A clean run lands nothing.** Stabilization commits exist to carry real fixes. If the whole surface passes without you changing a single file, there is nothing to commit and nothing to merge — `develop` is already in the state you validated. NEVER manufacture an empty or marker commit to "record" that stabilization ran; `git commit --allow-empty` is banned in this skill. The evidence of a clean run is your final report plus the `stabilize.yml` run URLs, not a no-op SHA on `develop` (see commit `915a9aeda` for exactly the wrong outcome). See **Finalization** for the two close-out cases.

## What "stabilize" covers

- **Every local check:** `npm run check` (typecheck + lint + format + channel/IPC/confirm-wiring guards), `npm run test` (unit), `npm run test:integration`, `npm run knip`, `npm run build`, `npm run test:smoke`, and ALL end-to-end suites — `core`, every `full-*` bucket, `online`, and the serialized `nightly` memory-leak soak.
- **The cross-platform surface that the local Mac cannot cover:** Linux + Windows for check/unit/build/smoke and all E2E, via the `stabilize.yml` GitHub workflow.
- **Release packaging/signing/notarization/Store/R2/update-metadata** (when stabilizing for a release): via the per-OS release dry-runs (`release-macos.yml` / `release-linux.yml` / `release-windows.yml` with `dry_run=true`).

Nightly BINARY publishing is NOT part of stabilize. `nightly-publish.yml` builds and ships the macOS + Linux nightly auto-update channel on its own cron; it runs no test suites (only a launch smoke before publishing) and you never drive it to "green." Leave it alone.

## Core Rules

- Always work on a separate branch based on `origin/develop`; never stabilize directly on `develop` or `main`.
- Keep the branch focused on stabilization. Do not mix unrelated cleanup, dependency upgrades, or feature work into the fix.
- **No empty or marker commits, ever.** Every commit this skill produces must carry an actual fix (a changed file). If the run validates clean with no fixes, it ends with zero commits — not a "stabilize develop" placeholder. `git commit --allow-empty` is forbidden.
- Prefer fixing Daintree over relaxing tests. Update a test only when it is stale, over-specific, or asserting behavior the product no longer promises. A flaky test is still a real signal — stabilize it (state-based waits, scoped locators, `expect.poll`), don't delete it.
- **Local-first is the default, not an option.** This repo is worked on from a powerful local Mac, so the full local suite is the primary validation line. Everything that can run locally must pass locally before any GitHub Actions run is dispatched. GitHub Actions is reserved for what genuinely cannot run locally: the non-macOS platforms (Linux, Windows) and CI-only packaging/signing/notarization/Store/R2/update-metadata steps. Do not use a GitHub macOS run to discover failures the local Mac can surface in full — it is slower and costs runner money.
- **Triage before you re-run.** Never blindly re-run a failing job. Either you fixed something (code/test/workflow) and are re-validating, or you have positively classified the failure as a flake (see "Intelligent flake triage") and are confirming it with a scoped re-run. Re-running the same red job hoping for green is not allowed.
- Never allow more than one active `stabilize.yml` run on the branch. For release dry runs, at most three full release runs may be active at once: one each of `release-macos.yml`, `release-linux.yml`, `release-windows.yml`. Before dispatching a replacement, list active runs for that workflow and cancel or wait for the superseded one (macOS runner cost matters).
- Expect several hours of iteration. Do not stop after the first fixed test, the first green single-spec run, or the first green job. The task is complete only when the full local gate is green and the full `stabilize.yml` workflow passes on the branch (and the release dry-runs when targeting a release).
- After each full-workflow failure, harvest every failed job before editing. Fix the earliest/root failure first, but keep the others in a visible queue so secondary failures are not lost.
- Before touching production code, read the relevant project instructions (`AGENTS.md`, and `CLAUDE.md` if present) and preserve Daintree architectural invariants.
- Do not modify user-owned agent config such as `~/.claude`, `~/.codex`, `~/.gemini`, or shell hooks. CI may create isolated runner config; local fixes should not.

## Long-Running Loop Discipline

Maintain the working log in conversation context by default. Context compaction is fine; keep status updates concrete enough that a compacted summary preserves the branch, run URLs, the failure queue, and the next action.

Only create a note if a durable handoff is needed across very long waits or repeated compactions. In this repo, `.gitignore` ignores both `tmp/` and `.tmp`, and `.tmp` already holds working notes and CI logs. Prefer `.tmp/stabilize-<branch-or-run-id>.md` when a note is necessary. Do not commit the note.

Track:

- Current branch and pushed SHA.
- Which OS stage you are in (A macOS-local / B Linux-CI / C Windows-CI), and whether the earlier stages are confirmed green.
- Last `stabilize.yml` run URL and conclusion for the OS currently in flight (watch the `stabilize-ok` gate job for the verdict), plus the URL/conclusion of the already-green Linux run once you move on to Windows.
- Any active release dry-run URLs and conclusions.
- Failure queue: job, platform, step, suite/spec, suspected cause, flake-vs-real classification, current status.
- Narrow validation commands already run.

## The Loop

Three OS stages, run strictly in order. Each must be fully green before the next begins: **Phase A — macOS (local)**, then **Phase B — Linux (CI)**, then **Phase C — Windows (CI)**. Do not parallelize the OSes. macOS locally catches ~90% of failures; Linux catches the GitHub-Actions-specific handful; Windows is the slowest and most flake-prone and is left for last. Dispatching Linux and Windows together would burn an expensive, long Windows run on any bug Linux is about to surface — that is exactly the waste this ordering avoids.

### Phase A — make everything green locally (macOS)

1. Establish the baseline. Run the full local gate and collect every failure before fixing anything:

   ```bash
   npm run check
   npm run test
   npm run test:integration
   npm run knip
   npm run build
   npm run test:smoke
   # E2E — the release-gated surface in one Playwright invocation:
   npx playwright test \
     --project=core \
     --project=full-terminal --project=full-worktree --project=full-presets \
     --project=full-platform --project=full-panels --project=full-resilience --project=full-plugins \
     --project=online
   # E2E — the serialized memory-leak soak (keep it separate, workers=1):
   npm run test:e2e:nightly
   ```

2. For each failure, reproduce the narrowest surface locally, classify it (real vs flake — see below), then fix the app/test/workflow and re-run that narrow surface until it is consistently green.
3. Re-run the broader local suite that owns the fix to catch regressions.
4. Repeat until the entire local gate is green. Do not dispatch any GitHub run while a locally-runnable surface is still red.

### Phase B — Linux on CI

Only after the full local gate is green do you touch GitHub Actions, and the first CI OS is **Linux**, on its own. Linux is cheaper and faster than Windows and surfaces the GitHub-Actions-specific failures (path/env/filesystem/runner differences) that the local Mac can't. Drive Linux fully green before Windows is ever dispatched — fixing it here means those same fixes are already in place when Windows runs, instead of being rediscovered on the slowest, most expensive runner.

**Do NOT run macOS on GitHub.** Phase A already ran the full gate on this macOS host, completely — a GitHub macOS run just pays for the priciest runner to redo what you proved locally and tells you nothing new. (macOS signing/notarization is validated by the release dry-runs, not here.) Reach for `platform=all`/`non-windows` only if you have a concrete reason to believe a macOS regression exists that the local run somehow missed — most stabilizations never dispatch macOS on CI at all.

5. Push the branch and dispatch `stabilize.yml` scoped to Linux only:

   ```bash
   git push -u origin <branch>
   gh workflow run stabilize.yml --ref <branch> -f platform=linux
   ```

6. Watch to a terminal state. `stabilize-ok` is the single gate that folds every required job into one pass/fail:

   ```bash
   RUN_ID=$(gh run list --workflow stabilize.yml --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch "$RUN_ID" --exit-status
   ```

7. On failure, inspect every failed job and pull the structured failure artifacts:

   ```bash
   gh run view "$RUN_ID" --json status,conclusion,headBranch,headSha,url,jobs
   gh run view "$RUN_ID" --log-failed
   gh run download "$RUN_ID" --dir artifacts   # failed-specs-*, failure-report-*, e2e-*-results-*, merged report
   ```

   The `failure-report-*` artifacts (one per shard, each containing a `failure-report.json`) list the failing specs with `projectName` + `titlePath`; the `failed-specs-*` artifacts hold the `--test-list` input for a scoped re-run. The merged `stabilize-merged-playwright-report` artifact has traces/screenshots.

8. Classify each failure (real vs flake), then act:
   - **Real, reproducible on a local-runnable surface (macOS/Linux-agnostic):** drop back to Phase A — reproduce, fix, and prove it locally before redispatching.
   - **Real, genuinely Linux-specific:** iterate that one spec on Linux with `e2e-single.yml` (`-f platform=linux`, below); fix; reconfirm.
   - **Flake:** confirm with a scoped re-run (below). If it passes consistently, note it and move on; if a spec keeps flaking, harden it (treat the flake as the bug) or, if it is already tracked as known-flaky, leave it to the quarantine flow (`.github/workflows/stale-quarantine.yml`).
9. Push fixes and re-run the narrow surface first, then re-dispatch `stabilize.yml -f platform=linux`. Repeat from step 6 until Linux is green.

### Phase C — Windows on CI

Only after Linux is fully green do you dispatch Windows. Windows is always the longest and most failure-prone OS, so it runs last and alone — by now the local + Linux fixes are already in the branch, so Windows is left to surface only its own genuinely Windows-specific issues (path separators, case-insensitive FS, line endings, slower cold launches, AV/handle contention), not bugs an earlier stage would have caught.

10. Dispatch `stabilize.yml` scoped to Windows only, then watch and triage it exactly as in Phase B steps 6–9 — same `gh run watch`, same artifact download, same real-vs-flake classification — but scope every CI re-run and `e2e-single.yml` repro to `-f platform=windows`:

    ```bash
    gh workflow run stabilize.yml --ref <branch> -f platform=windows
    ```

    The heavy Windows `full-*` buckets auto-shard (up to 16–32 ways) so each lands in ~10min wall-time, but the Windows memory-leak `nightly` soak still runs long — hence the overnight design. Repeat fix → re-dispatch until Windows is green.

11. When stabilizing for a release, additionally run the per-OS release dry-runs and drive each to green (see "Release dry runs"). These are independent per OS, so they need not be serialized the way the test stages are.

If a run is still in progress when reporting status, give the run URL, elapsed time, current failed/pending jobs, the flake-vs-real classification so far, and the next action. Do not present the work as complete while any required surface is still red or running.

## Intelligent Flake Triage

The dominant failure mode of the old nightly was E2E flake noise. Telling a flake from a real regression is the core skill here — it is what lets the agent replace the dumb nightly. Work the evidence, do not guess.

Signals that lean **flake**:

- A timing/race error shape: timeout waiting for a locator, element detached/re-rendered, "expected visible" on something that appears a beat later, screenshot diff on an animation frame, port/handle contention, slow cold launch.
- Platform-correlated and timing-sensitive: fails only on Windows (or only under heavy sharding) where launches are slower and filesystem/AV contention is higher.
- The exact same spec passes on a clean local re-run, and passes again on a second and third scoped re-run.
- Already known-flaky: annotated for quarantine, or recently touched by a stabilization fix.

Signals that lean **real regression**:

- A deterministic assertion failure tied to behavior you (or a recent PR) changed.
- A crash, unhandled rejection, native-module load error, IPC/channel drift, or a guard from `npm run check` failing.
- Reproduces every time locally, including with `--workers=1`.
- Fails the same way across platforms, not just one.

How to confirm a flake without blindly re-running the whole job:

- **Locally:** re-run the exact spec in isolation a few times. `npx playwright test --project=<suite> <path/to/spec.spec.ts> --workers=1 --repeat-each=3`. Consistent green = flake; any deterministic red = treat as real.
- **In CI, scoped to one spec on the failing OS:** `e2e-single.yml` (see below) with `retries=0` to see the raw flake rate, or `retries=2` to mirror CI's own retry budget.
- **In CI, scoped to a job's prior failures:** GitHub "Re-run failed jobs" re-runs only the failed shards, and `e2e.yml` automatically scopes the retry to the prior attempt's `failed-specs.txt` via `--test-list` (it drops `--shard` for that attempt). Use this to cheaply confirm whether a shard's failures evaporate on re-run.

A flake is not "free to ignore." If a spec flakes repeatedly, the durable fix is to stabilize that spec (replace sleeps with state-based waits, scope locators, add helper-level readiness gates) — that is real stabilization work and belongs in the branch. Only genuinely intermittent, already-tracked flakes are left to the quarantine flow.

## Workflow Map

Authoritative files:

- `.github/workflows/stabilize.yml` — the cross-platform validation surface (this skill's GitHub side). `workflow_dispatch` only, input `platform` (the workflow's own default is `linux-windows`; also `windows` | `linux` | `all` | `non-windows` | `macos`). This skill never relies on that default — it dispatches one OS at a time, `platform=linux` then `platform=windows`, so Linux is fully green before Windows starts. macOS is normally skipped on CI because the local run covers it. Runs `check`, `test`, `build` (+ smoke), `integration-test`, `knip`, `e2e-core`, `e2e-full` (seven buckets), `e2e-online`, `e2e-nightly` (memory-leak), a non-gating `merge-playwright-reports`, and the `stabilize-ok` gate. No cron, no issue creation, no publish.
- `.github/workflows/nightly-publish.yml` — publish-only nightly binaries (macOS + Linux) to the auto-update channel. Cron + manual dispatch, no tests. Not part of stabilization; don't drive it.
- `.github/workflows/e2e.yml` — the unified suite runner. Valid `suite`: `full`, `core`, `full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`, `full-plugins`, `online`, `nightly`, `demo`.
- `.github/workflows/e2e-single.yml` — the preferred CI loop for one failing spec. Accepts `platform`, `suite`, `test_file`, optional `grep`, `workers`, `retries`.
- `.github/workflows/release-macos.yml` / `release-linux.yml` / `release-windows.yml` — per-OS release workflows (#8052), each triggered by the same `v*` tag and each supporting `dry_run=true`. Independent — fix and re-run only the failing OS('s) workflow.
- `.github/workflows/ci.yml` — per-push/PR gate (`check` + sharded `test` + `build`/smoke on Ubuntu). `ci-ok` is the sole required status check.
- `scripts/ci/run-single-e2e.mjs` validates that a single E2E spec belongs to the selected suite.
- `docs/e2e-testing.md` and `docs/release.md` explain suite boundaries and dry-run expectations.

Useful local commands:

```bash
npm run check
npm run test
npm run test:integration
npm run knip
npm run build
npm run test:smoke
npm run test:e2e:core
npm run test:e2e:full-terminal
npm run test:e2e:full-worktree
npm run test:e2e:full-presets
npm run test:e2e:full-platform
npm run test:e2e:full-panels
npm run test:e2e:full-resilience
npm run test:e2e:full-plugins
npm run test:e2e:online
npm run test:e2e:nightly
npx playwright test --project=<suite> <path/to/spec.spec.ts> --workers=1 --repeat-each=3
# Release-gated broad pass (matches what stabilize.yml gates, minus the nightly soak):
npx playwright test --project=core --project=full-terminal --project=full-worktree --project=full-presets --project=full-platform --project=full-panels --project=full-resilience --project=full-plugins --project=online
```

The multi-project Playwright command above is the mandatory local broad pass before any GitHub run: it matches `core`, all `full-*`, and `online`. Add `--project=nightly` (serialized, `--workers=1`) for the memory-leak soak. Because the local machine is a full macOS host, this fully covers the macOS surface — do not lean on a GitHub macOS run to find these failures.

## Branch Setup

Start cleanly and choose an unused branch name:

```bash
git fetch origin --prune
git switch develop
git pull --ff-only origin develop
```

Use a name like `stabilize/YYYYMMDD` or `stabilize/<specific-area>-YYYYMMDD`. Check both local and remote refs before creating it:

```bash
git show-ref --verify --quiet refs/heads/<branch>
git ls-remote --exit-code --heads origin <branch>
git switch -c <branch> origin/develop
```

If the worktree is dirty before starting, inspect it. Do not overwrite unrelated user changes; either work with them if relevant or stop and ask how to proceed.

## Narrow Reproduction Loop

Reproduce the smallest failing surface first.

- Check/type/lint/format failure: run `npm run check` or the failing subcommand.
- Unit failure: run `npm run test -- <test-file-or-name>` when possible.
- Integration failure: run `npm run test:integration`.
- Knip failure: run `npm run knip`.
- Build/package/update-metadata failure: run `npm run build`, then the failing `electron-builder` or `scripts/ci/*` command. Packaging, signing, notarization, Store, and R2 checks may only be fully reproducible in Actions (release dry-runs / `nightly-publish.yml`).
- E2E failure: run the exact Playwright project and spec locally, usually with `--workers=1`, and `--repeat-each=3` when triaging a suspected flake. Use the suite that owns the spec path.

After the narrow local repro is consistently green, broaden locally. The full local gate must be green before pushing or dispatching any GitHub run; the only failures exempt from local proof are those reproducible solely on another OS (Linux/Windows) or in CI-only packaging/signing steps.

Suite-to-path mapping:

- `e2e/core/**` -> `core`
- `e2e/full/terminal/**` -> `full-terminal`
- `e2e/full/worktree/**` -> `full-worktree`
- `e2e/full/presets/**` -> `full-presets`
- `e2e/full/platform/**` -> `full-platform`
- `e2e/full/panels/**` -> `full-panels`
- `e2e/full/resilience/**` -> `full-resilience`
- `e2e/full/plugins/**` -> `full-plugins`
- `e2e/online/**` -> `online`
- `e2e/nightly/**` -> `nightly`

When the local OS differs from the failing OS, still run the local narrow test if useful, then use `e2e-single.yml` on the target platform.

## CI Iteration Commands

Push the branch before using GitHub Actions:

```bash
git push -u origin <branch>
```

Run a single failing E2E spec in CI (the preferred scoped loop):

```bash
gh workflow run e2e-single.yml \
  --ref <branch> \
  -f platform=<linux|macos|windows|all> \
  -f suite=<suite> \
  -f test_file=<spec-path> \
  -f grep='<optional-grep>' \
  -f workers=1 \
  -f retries=0
```

Run a whole E2E suite in CI:

```bash
gh workflow run e2e.yml --ref <branch> -f platform=<platform> -f suite=<suite>
```

Dispatch the cross-platform stabilize surface one OS at a time — Linux first, then Windows only after Linux is green:

```bash
gh workflow run stabilize.yml --ref <branch> -f platform=linux     # Phase B
gh workflow run stabilize.yml --ref <branch> -f platform=windows   # Phase C, only after Linux is green
# `all` / `non-windows` (adds macOS-on-CI) only for a macOS regression the local run somehow missed — rare.
```

Before starting a replacement full `stabilize.yml` (or release dry-run) run, cancel or wait for any older active run of the same workflow on the branch:

```bash
gh run list --workflow stabilize.yml --branch <branch> \
  --status in_progress --status queued --limit 20 \
  --json databaseId,headSha,status,url
gh run cancel <superseded-run-id>
```

Find and watch the run:

```bash
RUN_ID=$(gh run list --workflow stabilize.yml --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

## Release Dry Runs

When stabilizing for a release, the local gate + `stabilize.yml` cover tests on every OS, but packaging/signing/notarization/Store/R2/update-metadata only run in the release workflows. Drive each per-OS dry run to green too:

```bash
gh workflow run release-macos.yml   --ref <branch> -f dry_run=true
gh workflow run release-linux.yml   --ref <branch> -f dry_run=true
gh workflow run release-windows.yml --ref <branch> -f dry_run=true
```

Each dry run executes that OS's checks, unit tests, E2E gates, and its platform build/sign/package jobs (macOS `build-daintree` sign + notarize; Linux `build-daintree`; Windows `build-daintree-x64` + `build-daintree-arm64` → `assemble-windows-release` Store package + WACK) but skips R2/Store/website side effects. A dry run typically takes 30–40 minutes. They are independent — fix and re-run only the failing OS('s) workflow.

## Fixing Guidelines

- For flake caused by timing, replace sleeps with state-based waits, scoped locators, `expect.poll`, or helper-level readiness checks. Update `e2e/helpers/selectors.ts` or the component test id/ARIA label consistently for stale selectors.
- For cross-platform failures, account for Windows path separators, case-insensitive filesystems, shell differences, line endings, process cleanup, and slower cold launches.
- For the `nightly` memory-leak suite, preserve serialized execution; it must run `--workers=1`.
- For release package failures, verify `electron-builder.config.cjs`, `package.json` scripts, `scripts/ci/generate-update-metadata.mjs`, `scripts/ci/validate-update-metadata.mjs`, and platform-specific workflow conditionals before changing the workflow.
- For `online` failures, separate product/test failures from external agent CLI or `ANTHROPIC_API_KEY` problems. Do not add local user config to make online tests pass.
- If a job passes alone but fails in the full workflow, suspect ordering, cleanup, shared temp dirs, leaked processes, port reuse, caches, or platform matrix differences.

## Finalization

This is mandatory, not optional. How you close out depends on whether stabilization actually changed any files. Before anything else, settle that question against the base — do NOT decide from memory:

```bash
git fetch origin develop
git diff --quiet origin/develop...HEAD && echo "NO CHANGES — Case 1" || echo "FIXES PRESENT — Case 2"
git diff --stat origin/develop...HEAD   # see exactly what (if anything) the branch changed
```

### Case 1 — nothing needed fixing (the tree was already green)

If the full local gate and `stabilize.yml` (Linux + Windows) all passed without you editing a single file, there is **nothing to commit and nothing to merge**. `develop` is already in the exact state you validated. Do NOT fabricate a commit to record that stabilization ran — an empty `chore(ci): stabilize develop` commit (like `915a9aeda`) is the precise failure this skill forbids: it adds a meaningless SHA and history entry while changing nothing. The proof of a clean run is your final report and the run URLs.

Clean up and report instead — return to `develop` and remove the stabilize branch:

```bash
git switch develop
git branch -D <branch>
git push origin --delete <branch>   # only if you pushed it for CI
```

Then report: develop was already green, no commit was made, citing the local gate result and both `stabilize.yml` run URLs. **Done means (Case 1):** you are on `develop`, `develop` has NO new commit, and the stabilize branch is gone locally and on origin.

### Case 2 — fixes were made

All of the work above happens on the stabilize branch; stabilization is not finished until that work has been folded into `develop` as a **single commit**, pushed to origin, with the working tree left back on `develop`. A green branch that was never merged is an incomplete run.

When the full local gate is green and `stabilize.yml` has passed for both Linux (Phase B) and Windows (Phase C) on the branch (plus release dry-runs when targeting a release):

1. Run the relevant local final checks for touched areas, at minimum `npm run check` plus targeted tests.
2. Squash the branch to ONE commit (the entire stabilization lands as a single commit, not one commit per fix). Do this non-interactively from the stabilize branch — `git rebase -i` is not available here. Never pass `--allow-empty`; if `git commit` reports nothing to commit, you are actually in Case 1 — go back and close out there:

   ```bash
   git switch <branch>
   git reset --soft "$(git merge-base origin/develop HEAD)"   # collapse every commit since the base into the index
   git commit -m "fix(ci): stabilize <area>" -m "- <fix 1>" -m "- <flake hardened>"   # subject + body bullets
   ```

3. Write the commit in Daintree's standard format (the same convention the `/commit` command uses):
   - **Subject:** `<type>(<scope>): <description>` — present-tense imperative ("stabilize", not "stabilized"), under 72 characters. `type` is one of `feat` | `fix` | `refactor` | `test` | `docs` | `chore` | `style`; a stabilization run is usually `fix(ci): …` (workflow/build fixes) or `test(e2e): …` (spec/flake fixes), with `scope` inferred from what you touched.
   - **Body:** 2–5 bullet lines (`- …`) describing what changed and why — the concrete fixes and which flakes were hardened. Pass each as its own `-m`, or amend.
   - **No AI attribution:** never add `Co-Authored-By`, `Signed-off-by`, or any mention of Claude/AI.
4. Force-push the rewritten branch with lease — squashing rewrites history, so a plain push is rejected. Force-pushing the **stabilize branch** is expected and safe; never force-push `develop`.

   ```bash
   git push --force-with-lease origin <branch>
   ```

   A pure squash doesn't change the final tree, so it needs no re-validation. Re-run `stabilize.yml` only if a rebase onto a moved `origin/develop` (below) pulled in new changes.

5. Merge that single commit back into `develop` only after the branch is green, then return to `develop` and push:

   ```bash
   git switch develop
   git pull --ff-only origin develop
   git merge --ff-only <branch>     # fast-forwards develop to the one squashed commit (no merge commit)
   git push origin develop          # develop now carries the stabilization, pushed to origin
   git push origin --delete <branch>
   git branch -d <branch>
   ```

If `origin/develop` moved — so `git merge --ff-only` fails, or `git push origin develop` is rejected as non-fast-forward — do NOT force-push `develop`. Instead rebase the stabilize branch onto the new `origin/develop`, force-push the branch with lease, re-run the relevant checks/workflow, then ff-merge and push `develop` again:

```bash
git switch <branch>
git rebase origin/develop
git push --force-with-lease origin <branch>
# re-run validation, then repeat step 5
```

**Done means (Case 2)** — all four must be true before you report completion:

- You are on `develop` (not the stabilize branch).
- The stabilization is exactly one new commit on `develop`, and that commit changes files (never empty).
- `develop` has been pushed to origin.
- The stabilize branch has been deleted locally and on origin.

Final response must include the branch name (now deleted), the final commit SHA on `develop` (or, in Case 1, an explicit "no commit — develop was already green"), both `stabilize.yml` run URLs and conclusions (the Linux Phase-B run and the Windows Phase-C run, plus any release dry-run URLs), the local checks run, the flakes hardened, and confirmation that `develop` was pushed (Case 2) or untouched (Case 1).
