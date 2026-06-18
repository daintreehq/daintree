---
name: fix-workflow
description: Fix Daintree GitHub Actions workflows until the selected workflow passes. Use when the user asks Codex to repair the per-OS release workflows (`.github/workflows/release-macos.yml` / `release-linux.yml` / `release-windows.yml`) dry runs, `.github/workflows/nightly.yml`, release-gating E2E failures, nightly memory-leak failures, CI packaging/signing/update-metadata failures, or to repeatedly run a failing workflow until it passes on a dedicated branch and then squash/merge the fix back to `develop`.
---

# Fix Workflow

Drive Daintree release dry-run and nightly workflows to green. Treat this as a durable, multi-hour repair loop: work from the actual workflow logs, reproduce the narrow failure first, fix either the app, the test, or the workflow, rerun the failing surface, then rerun the full workflow. Continue through every newly exposed failure until the selected full workflow passes.

## Core Rules

- Always work on a separate branch based on `origin/develop`; never fix directly on `develop` or `main`.
- Keep the branch focused on release/nightly reliability. Do not mix unrelated cleanup, dependency upgrades, or feature work into the fix.
- Prefer fixing Daintree over relaxing tests. Update a test only when the test is stale, over-specific, or asserting behavior that the product no longer promises.
- Do not blindly rerun the same failing job without learning something. Rerun after a code/test/workflow fix, or once for an obvious external/transient service failure.
- Never allow more than one active GitHub Actions run per target workflow on the repair branch. For release dry runs, at most three full release runs may be active at once: one `release-macos.yml`, one `release-linux.yml`, and one `release-windows.yml`. For nightly, at most one `nightly.yml` run may be active. Before dispatching a replacement full workflow, list active runs for that workflow and cancel or wait for the superseded run to stop; this is especially important for macOS runner cost.
- **Local-first is the default, not an option.** This repo is worked on from a powerful local Mac, so the full local suite is the primary validation line, not a warm-up for GitHub Actions. Everything that can run locally must pass locally before any GitHub Actions run is dispatched. That means the complete local gate is green first: `npm run check`, `npm run test`, `npm run test:integration`, `npm run knip`, `npm run build`, `npm run test:smoke`, and ALL end-to-end suites — `core`, every `full-*` bucket, and `online` (add `nightly`, serialized, when targeting nightly). Reproduce, fix, and prove every failure locally; only then trigger GitHub. Do not use a GitHub macOS dry run to discover failures the local Mac can surface in full — it is slower, costs runner money, and the local machine already covers that surface completely. GitHub Actions is reserved for what genuinely cannot run locally: the non-macOS platforms (Linux, Windows) and CI-only packaging/signing/notarization/Store/R2/update-metadata steps.
- Expect several hours of iteration. Do not stop after the first fixed test, the first green single-spec run, or the first green job; the task is complete only when the full nightly or full release dry-run workflow passes on the repair branch.
- After each full workflow failure, harvest all failed jobs before editing. Fix the earliest/root failure first, but keep the other failures in a visible queue so secondary failures are not lost.
- Before touching production code, read the relevant project instructions (`AGENTS.md`, and `CLAUDE.md` if present) and preserve Daintree architectural invariants.
- Do not modify user-owned agent config such as `~/.claude`, `~/.codex`, `~/.gemini`, or shell hooks. CI may create isolated runner config; local fixes should not.

## Long-Running Loop Discipline

Maintain the working log in conversation context by default. Context compaction is acceptable; keep status updates concrete enough that the compacted summary can preserve branch, run URLs, failure queue, and next action.

Only create a note if a durable handoff is needed across very long waits or repeated compactions. If a note is needed, first discover the repo's ignored temporary directory rather than inventing a tracked file:

```bash
rg -n "tmp|temp|\\.tmp|temporary" .gitignore AGENTS.md CLAUDE.md docs scripts
find . -maxdepth 2 -type d \( -name tmp -o -name .tmp -o -name temp \)
```

In this repo, `.gitignore` ignores both `tmp/` and `.tmp`, and `.tmp` is already used for working notes and CI logs. Prefer `.tmp/fix-workflow-<branch-or-run-id>.md` when a note is necessary. Do not commit the note.

Track:

- Current branch and pushed SHA.
- Target workflow (`nightly.yml`, or one/all of `release-macos.yml` / `release-linux.yml` / `release-windows.yml` with `dry_run=true`).
- Last full workflow run URL and conclusion.
- Failure queue: job, platform, step, suite/spec, suspected cause, current status.
- Narrow validation commands already run.

The loop has two phases. Phase A (local) runs to completion before Phase B (GitHub) begins.

Phase A — fix everything locally first:

1. Identify the failure (from the user's run URL, or by inspecting the latest failed run with `gh run view <run-id> --log-failed`).
2. Run the full local gate: `npm run check`, `npm run test`, `npm run test:integration`, `npm run knip`, `npm run build`, `npm run test:smoke`, and every E2E suite — `core`, all `full-*`, `online` (plus serialized `nightly` when targeting nightly).
3. For each failure, reproduce the narrowest surface locally, fix the app/test/workflow, and rerun that narrow surface until it passes.
4. Rerun the broader local suite that owns the fix to catch regressions.
5. Repeat 2–4 until the entire local gate is green — all unit, integration, knip, build, smoke, and all E2E suites pass locally. Do not dispatch any GitHub run while a locally-runnable surface is still red.

Phase B — validate the CI-only surface on GitHub:

6. Only after the full local gate is green, push the branch and dispatch the target workflow(s). The remaining job here is the surface the local Mac cannot cover: Linux, Windows, and CI-only packaging/signing/notarization/Store/R2/update-metadata.
7. Wait for completion with `gh run watch <run-id> --exit-status`; long waits are expected.
8. If it fails, inspect every failed job with `gh run view <run-id> --log-failed` and artifacts as needed.
9. If a failure is reproducible locally (any macOS/Linux-agnostic surface), drop back to Phase A: fix and prove it locally before redispatching. Only genuinely OS-specific failures get iterated via `e2e-single.yml` on the target platform.
10. Push and rerun the full workflow. Repeat from step 7 until the full target workflow is green.

If a run is still in progress when reporting status, give the run URL, elapsed time, current failed/pending jobs, and the next action. Do not present the work as complete while any required workflow is still running.

## Workflow Map

Authoritative files:

- `.github/workflows/nightly.yml` runs `check`, `test`, `build`, `integration-test`, `knip`, `e2e-core`, `e2e-full`, `e2e-online`, `e2e-nightly`, then `publish` when `platform` is empty/all.
- `.github/workflows/release-macos.yml`, `release-linux.yml`, and `release-windows.yml` are three independent per-OS release workflows (#8052), each triggered by the same `v*` tag and each supporting manual dry runs with `dry_run=true`. Each runs checks, unit tests, that OS's `core` + all seven (auto-sharded, #8053) `full-*` buckets + `online`, and that OS's `build-daintree` job without publishing to R2, Microsoft Store, or the website. They're independent — fix and re-run only the failing OS('s) workflow.
- `.github/workflows/e2e.yml` is the unified suite runner. Valid `suite`: `full`, `core`, `full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`, `full-plugins`, `online`, `nightly`.
- `.github/workflows/e2e-single.yml` is the preferred CI loop for one failing spec. It accepts `platform`, `suite`, `test_file`, optional `grep`, `workers`, and `retries`.
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
npx playwright test --project=<suite> <path/to/spec.spec.ts> --workers=1
npx playwright test --project=core --project=full-terminal --project=full-worktree --project=full-presets --project=full-platform --project=full-panels --project=full-resilience --project=full-plugins --project=online
```

For release dry-run E2E work, the multi-project Playwright command above is the mandatory local broad pass: it matches the release-gated `core`, all `full-*`, and `online` projects without pulling in unrelated `nightly` soak or manual `screenshots` jobs. It must pass locally before any dry run is dispatched. Because the local machine is a full macOS host, this command fully covers the macOS dry-run E2E surface — do not lean on a GitHub macOS dry run to find these failures.

## Branch Setup

Start cleanly and choose an unused branch name:

```bash
git fetch origin --prune
git switch develop
git pull --ff-only origin develop
```

Use a name like `fix/release-nightly-ci-YYYYMMDD` or `fix/<specific-failure>-YYYYMMDD`. Check both local and remote refs before creating it:

```bash
git show-ref --verify --quiet refs/heads/<branch>
git ls-remote --exit-code --heads origin <branch>
git switch -c <branch> origin/develop
```

If the worktree is dirty before starting, inspect it. Do not overwrite unrelated user changes; either work with them if they are relevant or stop and ask how to proceed.

## Find the Failure

If the user gave a run URL, inspect that run. Otherwise list recent failures:

```bash
gh run list --workflow nightly.yml --branch develop --limit 10
gh run list --workflow release-macos.yml --branch develop --limit 10
gh run list --workflow release-linux.yml --branch develop --limit 10
gh run list --workflow release-windows.yml --branch develop --limit 10
```

For a run:

```bash
gh run view <run-id> --json status,conclusion,headBranch,headSha,url,jobs
gh run view <run-id> --log-failed
```

Extract: workflow, job name, platform, failing step, error text, suite, spec path, retry count, and artifact names. For E2E failures, download artifacts when traces/screenshots matter:

```bash
gh run download <run-id> --dir artifacts
```

## Narrow Reproduction Loop

Reproduce the smallest failing surface first.

- Check/type/lint/format failure: run `npm run check` or the failing subcommand.
- Unit failure: run `npm run test -- <test-file-or-name>` when possible.
- Integration failure: run `npm run test:integration`.
- Knip failure: run `npm run knip`.
- Build/package/update metadata failure: run `npm run build`, then the failing `electron-builder` or `scripts/ci/*` command from the workflow. Packaging, signing, notarization, Windows Store, and R2 checks may only be fully reproducible in Actions.
- E2E failure: run the exact Playwright project and spec locally, usually with `--workers=1`. Use the suite that owns the spec path.

After the narrow local repro passes, broaden locally. The full local gate must be green before pushing or dispatching any GitHub run; the only failures exempt from local proof are ones reproducible solely on another OS (Linux/Windows) or in CI-only packaging/signing steps.

- Same suite: `npx playwright test --project=<suite>`
- Release-gated all-e2e (required local pass before any dry run): `npx playwright test --project=core --project=full-terminal --project=full-worktree --project=full-presets --project=full-platform --project=full-panels --project=full-resilience --project=full-plugins --project=online`
- Nightly target: include `--project=nightly` and keep it serialized.

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

When local OS differs from the failing OS, still run the local narrow test if useful, then use `e2e-single.yml` on the target platform.

## CI Iteration Commands

Push the repair branch before using GitHub Actions:

```bash
git push -u origin <branch>
```

Run a single failing E2E spec in CI:

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

Before starting a replacement full release or nightly run, cancel or wait for any older active run of the same workflow on the branch:

```bash
gh run list --workflow <workflow.yml> --branch <branch> \
  --status in_progress --status queued --limit 20 \
  --json databaseId,headSha,status,url
gh run cancel <superseded-run-id>
```

Run the full nightly workflow:

```bash
gh workflow run nightly.yml --ref <branch> -f platform=all
```

Run the full release dry run:

```bash
gh workflow run release-macos.yml   --ref <branch> -f dry_run=true
gh workflow run release-linux.yml   --ref <branch> -f dry_run=true
gh workflow run release-windows.yml --ref <branch> -f dry_run=true
```

Find and watch the run:

```bash
RUN_ID=$(gh run list --workflow <workflow.yml> --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

On failure, inspect `gh run view "$RUN_ID" --log-failed`, apply the next fix, commit or amend locally, push, and rerun the narrow job first. Continue until the narrow job passes, then rerun the full nightly or release dry-run workflow.

## Fixing Guidelines

- For flake caused by timing, replace sleeps with state-based waits, scoped locators, `expect.poll`, or helper-level readiness checks.
- For stale selectors, update `e2e/helpers/selectors.ts` or the component test id/ARIA label consistently.
- For cross-platform failures, account for Windows path separators, case-insensitive filesystems, shell differences, line endings, process cleanup, and slower cold launches.
- For nightly memory leak tests, preserve serialized execution; `nightly` must use `--workers=1`.
- For release package failures, verify `electron-builder.config.cjs`, `package.json` scripts, `scripts/ci/generate-update-metadata.mjs`, `scripts/ci/validate-update-metadata.mjs`, and platform-specific workflow conditionals before changing the workflow.
- For online failures, separate product/test failures from external agent CLI or `ANTHROPIC_API_KEY` problems. Do not add local user config to make online tests pass.
- If the same job passes alone but fails in the full workflow, suspect ordering, cleanup, shared temp dirs, leaked processes, port reuse, caches, or platform matrix differences.

## Finalization

When the full target workflow passes on the branch:

1. Run the relevant local final checks for touched areas, at minimum `npm run check` plus targeted tests.
2. Squash the branch to one commit with a conventional subject, usually `fix(ci): stabilize release and nightly workflow`.
3. Include a bullet list in the commit body summarizing the concrete fixes.
4. Push the single-commit branch and rerun the full target workflow if the squash changed the commit SHA materially.
5. Merge the single commit back into `develop` only after the branch workflow is green:

```bash
git switch develop
git pull --ff-only origin develop
git merge --ff-only <branch>
git push origin develop
git push origin --delete <branch>
git branch -d <branch>
```

If `develop` moved and `--ff-only` cannot merge, rebase the branch onto `origin/develop`, rerun the relevant checks/workflow, then merge. Do not force-push `develop`.

Final response must include the branch name, final commit SHA, workflow run URL(s), local checks run, and whether the remote branch was deleted.
