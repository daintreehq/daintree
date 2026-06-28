---
name: stabilize
description: Drive Daintree to a fully green, stable state across every check we can run — typecheck/lint/format, unit, integration, knip, build, smoke, and the full Playwright E2E surface (core, all seven full-* buckets, online, and the nightly memory-leak soak). Local-first: run everything on the local Mac, fix real failures, intelligently re-run flaky E2E, then dispatch the cross-platform `stabilize.yml` GitHub workflow (and release dry-runs) for the Linux/Windows/CI-only surface and iterate until everything is green. Use before a release, or every few days to keep the tree healthy. Invoke with "Please stabilize using the stabilize workflow."
---

# Stabilize

Drive the Daintree tree to green and keep it there. This is the replacement for the old scheduled nightly: instead of a dumb cron that runs everything once and opens a low-signal `[Nightly] Tests failed` issue every time an E2E flake trips, an agent runs the whole surface, reads the results, tells flakes apart from real regressions, re-runs intelligently, fixes the real failures, and only reports when the work is actually done. Treat this as a durable, multi-hour loop. All the work happens on a dedicated stabilize branch off `origin/develop`. The job is complete only when the full local gate is green AND the cross-platform `stabilize.yml` workflow passes on the branch (plus release dry-runs when stabilizing for a release) AND that work has been squashed into a single commit, merged into `develop`, and pushed to origin — with the working tree left back on `develop`. See **Finalization** for the exact close-out and its "done means" checklist.

There is no issue-creation step anywhere in this flow. You are the triage. Do not open or update a `nightly-failure` issue — that mechanism was retired with the scheduled nightly.

## What "stabilize" covers

- **Every local check:** `npm run check` (typecheck + lint + format + channel/IPC/confirm-wiring guards), `npm run test` (unit), `npm run test:integration`, `npm run knip`, `npm run build`, `npm run test:smoke`, and ALL end-to-end suites — `core`, every `full-*` bucket, `online`, and the serialized `nightly` memory-leak soak.
- **The cross-platform surface that the local Mac cannot cover:** Linux + Windows for check/unit/build/smoke and all E2E, via the `stabilize.yml` GitHub workflow.
- **Release packaging/signing/notarization/Store/R2/update-metadata** (when stabilizing for a release): via the per-OS release dry-runs (`release-macos.yml` / `release-linux.yml` / `release-windows.yml` with `dry_run=true`).

Nightly BINARY publishing is NOT part of stabilize. `nightly-publish.yml` builds and ships the macOS + Linux nightly auto-update channel on its own cron; it runs no test suites (only a launch smoke before publishing) and you never drive it to "green." Leave it alone.

## Core Rules

- Always work on a separate branch based on `origin/develop`; never stabilize directly on `develop` or `main`.
- Keep the branch focused on stabilization. Do not mix unrelated cleanup, dependency upgrades, or feature work into the fix.
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
- Last `stabilize.yml` run URL and conclusion (watch the `stabilize-ok` gate job for the verdict).
- Any active release dry-run URLs and conclusions.
- Failure queue: job, platform, step, suite/spec, suspected cause, flake-vs-real classification, current status.
- Narrow validation commands already run.

## The Loop

Two phases. Phase A (local) runs to completion before Phase B (GitHub) begins.

### Phase A — make everything green locally

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

### Phase B — validate the cross-platform / CI-only surface

5. Only after the full local gate is green, push the branch and dispatch `stabilize.yml`. The remaining surface is what the local Mac cannot cover: Linux, Windows, and (for releases) CI-only packaging/signing/notarization/Store/R2/update-metadata.

   **Do NOT re-run macOS on GitHub.** This skill always runs the full gate locally first (Phase A), and the dev machine is macOS — so the mandatory local run already IS the macOS surface, completely. Dispatching macOS on a GitHub runner just pays for the most expensive runner to redo what you already proved locally, and tells you nothing new. The default platform is therefore `linux-windows` (Linux + Windows, no macOS), not `all`.

   ```bash
   git push -u origin <branch>
   # Normal cross-OS pass after a clean local run — Linux + Windows, no macOS. Fine to run overnight:
   gh workflow run stabilize.yml --ref <branch> -f platform=linux-windows
   # In practice macOS passes on the first local run and Linux is usually green too; Windows is the
   # lone straggler that needs a few fixes + re-runs. Iterate it on its own:
   gh workflow run stabilize.yml --ref <branch> -f platform=windows
   # macOS-on-CI (`all`) ONLY if a macOS issue genuinely can't be reproduced locally — this should be rare:
   gh workflow run stabilize.yml --ref <branch> -f platform=all
   ```

   So the normal loop is: local gate green → `platform=linux-windows` → Linux passes, Windows has a handful of failures → iterate `platform=windows` (or `e2e-single.yml` for one spec) until green. Reach for `all` only when you have a concrete reason to believe a macOS regression exists that the local run somehow missed — most stabilizations never dispatch macOS on CI at all. (macOS signing/notarization is validated by the release dry-runs, not here.) The heavy Windows full-\* buckets auto-shard (up to 16–32 ways) so each lands in ~10min wall-time, but the Windows memory-leak `nightly` soak still runs long — hence "overnight."

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
   - **Real, genuinely OS-specific (Linux/Windows-only):** iterate that one spec on the target platform with `e2e-single.yml` (below); fix; reconfirm.
   - **Flake:** confirm with a scoped re-run (below). If it passes consistently, note it and move on; if a spec keeps flaking, harden it (treat the flake as the bug) or, if it is already tracked as known-flaky, leave it to the quarantine flow (`.github/workflows/stale-quarantine.yml`).
9. Push fixes and re-run the narrow surface first, then re-dispatch the full `stabilize.yml`. Repeat from step 6 until it is green.
10. When stabilizing for a release, additionally run the per-OS release dry-runs and drive each to green (see "Release dry runs").

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

- `.github/workflows/stabilize.yml` — the cross-platform validation surface (this skill's GitHub side). `workflow_dispatch` only, input `platform` (default `linux-windows`; also `windows` | `linux` | `all` | `non-windows` | `macos`). macOS is normally skipped on CI because the local run covers it. Runs `check`, `test`, `build` (+ smoke), `integration-test`, `knip`, `e2e-core`, `e2e-full` (seven buckets), `e2e-online`, `e2e-nightly` (memory-leak), a non-gating `merge-playwright-reports`, and the `stabilize-ok` gate. No cron, no issue creation, no publish.
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

Run the full cross-platform stabilize surface:

```bash
gh workflow run stabilize.yml --ref <branch> -f platform=<linux-windows|windows|linux|all|non-windows|macos>
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

This is mandatory, not optional. All of the work above happens on the stabilize branch; stabilization is not finished until that work has been folded into `develop` as a **single commit**, pushed to origin, with the working tree left back on `develop`. A green branch that was never merged is an incomplete run.

When the full local gate is green and `stabilize.yml` passes on the branch (plus release dry-runs when targeting a release):

1. Run the relevant local final checks for touched areas, at minimum `npm run check` plus targeted tests.
2. Squash the branch to ONE commit (the entire stabilization lands as a single commit, not one commit per fix). Do this non-interactively from the stabilize branch — `git rebase -i` is not available here:

   ```bash
   git switch <branch>
   git reset --soft "$(git merge-base origin/develop HEAD)"   # collapse every commit since the base into the index
   git commit -m "fix(ci): stabilize <area>"                  # one commit; conventional subject (or test(e2e): stabilize <suite>)
   ```

3. Use a body with a bullet list of the concrete fixes and which flakes were hardened (pass extra `-m` flags or amend).
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

**Done means** — all four must be true before you report completion:

- You are on `develop` (not the stabilize branch).
- The stabilization is exactly one new commit on `develop`.
- `develop` has been pushed to origin.
- The stabilize branch has been deleted locally and on origin.

Final response must include the branch name (now deleted), the final commit SHA on `develop`, the `stabilize.yml` run URL and conclusion (and any release dry-run URLs), the local checks run, the flakes hardened, and confirmation that `develop` was pushed.
