---
name: release
disable-model-invocation: true
argument-hint: "[version e.g. 0.47.0] [--dry-run | --no-dry-run]"
description: "Ship a Daintree app release end to end, unattended after one question. Confirms the version, pins develop and cuts the release branch in its own worktree, proves before tagging what only the tag run would otherwise find (E2E specs no CI run has executed per OS, unit-job headroom, release-pipeline changes that need a dry run) while parallel analyst agents build the changelog, then merges into main and develop, tags, pushes atomically, watches the three per-OS release workflows to green, and recovers with one restart at most: every failure triaged from the run's own artifacts, reproduced locally, fixed together and proven before re-tagging or cutting a patch. Ends with the GitHub Release. Use when the user wants to release, ship, cut or tag a new version of the Daintree app. Not for the plugin npm packages; that is the `release-packages` skill."
---

# Release

Ship a complete gitflow release of the Daintree app. The user is involved for the first minute, while you settle the version. After that you run to the end on your own: no `AskUserQuestion`, no "shall I proceed?", no pausing for approval of the changelog, the merge, the tag or the push. Invoking this skill is the approval for all of it, including commits and pushes to the release branch, `main` and `develop`.

Autonomy isn't silence. Post a short status line at every phase change, when a long wait starts (what you're waiting on and roughly how long), and whenever something fails, is retried or recovers. Say what you did and what's next; never ask.

**Argument (may be empty):** `$ARGUMENTS`. A semver version pre-answers the version question, so you ask nothing at all. `--dry-run` forces the dry run, `--no-dry-run` skips it; without either, the evidence decides (Phase 2).

## The time budget, and why the tag run must be the last run

A clean release takes about three hours from the question to all four feeds: about 45 minutes for the changelog and the readiness proofs, which run side by side, then about two hours of tag runs, with macOS the long pole because only about five macOS jobs run at once. Every restart of a tag run costs another two hours. v0.47.0 took over six hours: a unit job that had outgrown its timeout, then an E2E spec merged after stabilize that had never run on the macos-15 runner, each found by a tag run and fixed by a re-tag, and a re-tag pushed while Windows was still running broke Windows' publish.

So the whole skill is organised around two rules:

1. **Find before tagging what only a tag run would find** (Phase 2). Stabilize proves the code; it doesn't run the release workflows' unit jobs or anything on the macos-15 runner, and PR CI runs no E2E at all.
2. **If a tag run fails anyway, restart once.** Let every run finish, collect every failure, reproduce and fix them together, prove the fix, then restart (Phase 5 and `references/ci-and-recovery.md`).

## Files

| File | Read it |
| --- | --- |
| `references/release-notes.md` | before writing any changelog text: format, voice, what's in and out, size |
| `references/changelog-pipeline.md` | at Phase 3: the collect, analyst, editor and verifier pipeline with the agent briefs |
| `references/ci-and-recovery.md` | before watching any run: the workflow map, triage, reproducing locally, rerun vs re-tag vs patch, the procedures, known traps |
| `scripts/collect-changes.mjs` | at Phase 1: PRs since the last tag, chunked for the analysts |
| `scripts/readiness.mjs` | at Phase 2: dry-run decision, E2E specs no CI run has executed per OS, unit-job headroom |
| `scripts/watch-runs.mjs` | whenever you wait on runs: bounded polling, per-run job progress, the four feeds |
| `scripts/run-failures.mjs` | the moment any job fails: why each job ended, failing tests with errors and screenshots |

Paths are relative to this skill's directory, `.claude/skills/release/`. Scratch files go in `W=<scratchpad>/release-vX.Y.Z`, never in the repo.

## How the release is laid out

- **One pinned commit.** `RELEASE_SHA` is `origin/develop` at the moment the version is settled. The changelog is researched against it and the release branch is cut from it, so what was researched, validated and shipped is the same tree. PRs that merge into `develop` afterwards wait for the next release.
- **Its own worktree.** All release work happens in `WT=<repo root>/../daintree-worktrees/release-vX.Y.Z`, on `release/vX.Y.Z`. The main checkout and any other session's worktree are never touched, and `main` and `develop` are only ever updated by pushing commits built on detached `origin/main` and `origin/develop` inside `WT`.
- **Shell blocks that can't fail silently.** The shell is zsh. Every block starts with `set -euo pipefail`. Write variables in braces wherever a `:` follows: `"${MAIN}:refs/heads/main"`, never `"$MAIN:refs/heads/main"`, which zsh reads as the `:r` modifier and mangles into `…efs/heads/main` (both v0.47.0 pushes failed this way). Send a push's output to a file and check its exit code; never pipe it into `tail` or `grep`, which hides the failure and lets the next line run. If any command fails unexpectedly, stop the block and find out why before continuing.
- **Waiting.** Never use `gh run watch`: it exits non-zero on a dropped connection, which reads as a red run. Wait with `scripts/watch-runs.mjs --runs <ids> --minutes 9 --version X.Y.Z` in the foreground (Bash timeout 600000), repeated. It prints each run's job progress, failed or cancelled jobs and the four feeds, and exits 0 when every run is terminal, 4 as soon as a job newly fails or is cancelled (triage it then; the runs keep going), 3 when the window ends.

## Phase 0: Preflight, then the one question

Check everything that could stop the release before asking anything, so nothing fails after the user walks away:

- `gh auth status` works. `git fetch origin --tags --prune` succeeds.
- `main` carries no content `develop` lacks: `git diff --quiet origin/develop...origin/main`. Merge commits from past re-tags can sit on `main` alone with no content; that's fine. A content difference is a hotfix on `main`; note it, since the release merge will carry it.
- No release workflow run is queued or in progress: for each of `release-macos.yml`, `release-linux.yml`, `release-windows.yml`, `gh run list --workflow=<wf> --limit 20 --json status --jq '[.[] | select(.status != "completed")] | length'` is 0. One in flight means another release or dry run is underway; stop.

If any of these fails, stop and say why. It's one of the few times you hand back.

Then work out the version:

1. Current version from `package.json` on `origin/develop`; baseline from `git tag -l "v*" --sort=-version:refname | head -1`. The tag needn't be an ancestor of `develop` (past re-tags left the tag's merge commit on `main` only); `git merge-base <tag> origin/develop` must succeed.
2. One quick call gives the PR titles: `gh pr list --state merged --base develop --search "merged:>=<tag date>" --limit 1000 --json title --jq '.[].title'`. Read the `## [Unreleased]` section of `CHANGELOG.md` too. A breaking change (`!:`, `BREAKING CHANGE`, an Unreleased `### Breaking Changes`) or any `feat` means minor; only fixes mean patch. Pre-1.0, breaking changes ride a minor bump; 1.0.0 is never recommended, only offered.
3. A valid version in `$ARGUMENTS` that's greater than the current one: use it and skip the question. One that isn't greater: stop and say why. Either way, `release/vX.Y.Z` must not exist locally or on origin, and `vX.Y.Z` must not exist as a tag.
4. Otherwise ask one single-select `AskUserQuestion` that stands on its own: current version, recommendation, why ("291 features and 2 breaking changes since v0.46.0"), and what happens next ("after this I run the whole release unattended"). Options: the recommendation labelled `(Recommended)`, then the next patch, the minor after it, and `1.0.0`.

That answer is the last input you take. Post: "Releasing vX.Y.Z unattended from develop at <short sha>."

## Phase 1: Pin and cut

```bash
set -euo pipefail
git fetch origin
RELEASE_SHA=$(git rev-parse origin/develop)
mkdir -p "$(git rev-parse --show-toplevel)/../daintree-worktrees"
WT="$(git rev-parse --show-toplevel)/../daintree-worktrees/release-vX.Y.Z"
git worktree add -b release/vX.Y.Z "${WT}" "${RELEASE_SHA}"
ln -s "$(git rev-parse --show-toplevel)/node_modules" "${WT}/node_modules"
git -C "${WT}" push -u origin release/vX.Y.Z
```

Never run `npm ci` or `npm install` in `WT`; the symlink shares the main checkout's install. If a fix later needs a workspace package's own `node_modules`, symlink that one too.

Start the change collection in the background, since it takes a minute and Phase 3 needs it:

```bash
node .claude/skills/release/scripts/collect-changes.mjs --out "${W}/changes" --head "${RELEASE_SHA}"
```

From here on, work in `WT`. Phases 2 and 3 run side by side: dispatch every Phase 2 proof first, then build the changelog while they run.

## Phase 2: Readiness

```bash
node .claude/skills/release/scripts/readiness.mjs --head "${RELEASE_SHA}" > "${W}/readiness.json"
```

It answers three questions, each with the evidence behind it. Act on all three, then post one status line covering them ("Readiness: no dry run (stabilize green 3 h ago, 4 PRs since); 2 macOS specs and 1 Linux/Windows spec dispatched to e2e-single; unit headroom fine").

**Dry run (`recommend`, `oses`).** Stabilize runs check, unit, build, smoke and every E2E bucket on Linux and Windows plus a local Mac pass; the nightly packages, signs and notarizes macOS and Linux. Between them they cover nearly everything, so a full dry run is the exception. `"skip"`: say why and go on; if it lists publish-path files, say they'll first run in the tag's publish job. `"dry-run"`: dispatch only the OSes in `oses` (`--dry-run` forces all three, `--no-dry-run` skips it; say which in the summary) on the release branch, about two hours, Windows the longest:

```bash
gh workflow run release-<os>.yml --ref release/vX.Y.Z -f dry_run=true
```

**E2E specs no CI run has executed (`specs`).** PR CI runs no E2E, stabilize runs it on Linux and Windows only, and the macos-15 runner has a fixed 1024x768 screen that a big local Mac never reproduces. So a spec added or changed since stabilize has never run on Linux or Windows CI, and one changed since the last green macOS release run has never run on macos-15. Prove each one on its OS before tagging, all dispatched at once:

```bash
gh workflow run e2e-single.yml --ref release/vX.Y.Z -f platform=<os> -f suite=<suite> -f test_file=<file> -f retries=0
```

Each run's title is `single · <suite> · <os> · <file>`, so resolve every proof's run ID from `gh run list --workflow=e2e-single.yml --branch release/vX.Y.Z --limit 100 --json databaseId,headSha,displayTitle`, matching `headSha` to the branch head and the title to the proof. Have an ID for every planned proof before waiting, then wait on them with `watch-runs.mjs`. They take 10 to 20 minutes, inside the changelog's time.

**Unit-job headroom (`unitHeadroom`).** A release workflow's unit job that used more than three quarters of its timeout last release will blow it as the suite grows, and only a tag run would show it. Fix that before tagging: shard the job further (the release workflows shard it in two since v0.47.0) or speed up the file that got slow (`run-failures.mjs --run <id> --job <job id>` on that run's longest unit job lists the slowest files). Don't raise the timeout. A flag that compares a pre-sharding duration with today's sharded job is stale; say so and move on.

**A failed proof** is fixed on the release branch, which costs minutes now instead of hours later: triage it with `run-failures.mjs`, reproduce it (`references/ci-and-recovery.md`, "Reproduce locally"), fix it, and commit through the `commit` skill. Then run `readiness.mjs` again on the new head and re-prove everything the fix can reach: just that spec for a spec-only fix, every proof on that OS (or all OSes) for a change to an E2E helper or product code.

Don't start Phase 4 until every proof and dry run on the current release branch head is green.

## Phase 3: Changelog

Follow `references/changelog-pipeline.md`: one analyst agent per chunk of about 40 PRs in parallel, one editor, one adversarial verifier, then you settle it. `references/release-notes.md` governs every line. The result is `${W}/changelog-vX.Y.Z.md`.

Show it, as a status message rather than a question:

```
vX.Y.Z changelog: 2 breaking, 64 features, 41 fixes, 5 performance (from 590 PRs, 28 direct commits; 212 folded or dropped).
Headlines: <the stories the intro leads with>
Left out: <items you judged not user-visible or churn and weren't sure about, one line each; or "nothing contentious">
```

followed by the full section, so the user can read exactly what ships. Carry on without waiting. If they interject with edits while you're still working, apply them.

## Phase 4: Release commit, merge, tag, push

In `WT`, on `release/vX.Y.Z`:

1. `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and both version fields in `package-lock.json`).
2. Write the section into `CHANGELOG.md` directly under `# Changelog`, replacing the `## [Unreleased]` section. Date it today. If a fix made during readiness was user-visible, add it.
3. `npx prettier --check CHANGELOG.md package.json package-lock.json`, trusting the exit code over the summary.
4. Commit `chore(release): release vX.Y.Z` with those three files only and no attribution trailers. It's the release's own bookkeeping commit, so it doesn't go through the `commit` skill. Push the release branch.
5. Merge, tag and push, building `main` and `develop` on detached heads:

   ```bash
   set -euo pipefail
   git fetch origin
   git checkout --detach origin/main
   git merge --no-ff release/vX.Y.Z -m "chore(release): merge release/vX.Y.Z into main"
   test "$(node -p "require('./package.json').version")" = "X.Y.Z"
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   MAIN=$(git rev-parse HEAD)
   git checkout --detach origin/develop
   git merge --no-ff "${MAIN}" -m "chore(release): merge main into develop after vX.Y.Z release"
   DEV=$(git rev-parse HEAD)
   git push --atomic origin "${MAIN}:refs/heads/main" "${DEV}:refs/heads/develop" "refs/tags/vX.Y.Z" > "${W}/push.log" 2>&1 || { cat "${W}/push.log"; exit 1; }
   git ls-remote origin refs/heads/main "refs/tags/vX.Y.Z^{}"
   ```

   The last line must show `main` and the tag both at `${MAIN}`. `--atomic` means `main`, `develop` and the tag land together or not at all, so the tag can never trigger a release whose `main` was rejected.

   - **The develop merge conflicts in `CHANGELOG.md`** when PRs added `## [Unreleased]` entries after the pin. Keep `develop`'s `## [Unreleased]` heading with only the entries that aren't in the new release section, then the new `## [X.Y.Z]` section, then every older section in order. Other conflicts mean `develop` and the release branch both changed a file since the pin; keep `develop`'s side unless the release branch's change was a release fix, in which case keep both.
   - **The push is rejected** because `main` or `develop` moved on origin: `git tag -d vX.Y.Z`, then run the block again from the top. Never force it.

6. Only after `ls-remote` confirms the push: `git push origin --delete release/vX.Y.Z`. Then post: "Tagged vX.Y.Z; main, develop and the tag pushed together."

Resolve the three tag-triggered run IDs (`gh run list --workflow=<wf> --event push --limit 3`, matching `headBranch == vX.Y.Z` and `headSha == ${MAIN}`) and post their URLs. A clean tag run takes about two hours: Linux about 1h10, macOS and Windows near 2h.

## Phase 5: Watch to green, restart once at most

Wait with `watch-runs.mjs` and track the four update feeds separately (`latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`, `latest.yml` for Windows): Linux publishes x64 then arm64, and either can fail alone. Post a line as each OS finishes ("Linux x64 and arm64 published in 1h08; macOS in E2E, Windows building").

When a job fails, follow `references/ci-and-recovery.md`. In short:

1. **Triage at once, without stopping anything.** `run-failures.mjs --run <id> --out ${W}/failures` gives why each job ended and every failed test with its error and screenshots. Look at the screenshot before theorising.
2. **Infrastructure:** rerun just those jobs once the run is terminal (`gh run rerun <id> --failed`). Never re-tag for a flake.
3. **Real failures:** reproduce locally where the failure isn't tied to the runner, fix on one branch cut from the tag, and prove the fix (locally, then `e2e-single` on the failing OS for anything E2E).
4. **Let every run finish before restarting anything.** A failed run can't publish, but its remaining jobs keep finding failures, and the restart has to carry all of them. And never move the tag while any run on it is still going: a re-tag under a running run makes its later checkouts refuse the moved ref (v0.47.0's Windows assemble died that way, after both builds passed).
5. **Then restart once,** per the decision table: re-tag or patch. Reruns of infrastructure failures don't count as restarts. A second restart is allowed only for a failure the first restart could not have carried, and the budget in `references/ci-and-recovery.md` caps the total.

Stop only for the few things only a person can fix (an expired Apple agreement, an expired certificate). Keep going until all four feeds carry `vX.Y.Z` (or its patch) or the retry budget is spent.

## Phase 6: Wrap up

1. **Verify the feeds.** `watch-runs.mjs` prints all four; each must read `X.Y.Z`.
2. **Note the Microsoft Store step.** It reports as a warning, never a failure, and has skipped on every release so far because its secrets aren't configured: `gh run view <windows run> --log | grep -i "Microsoft Store submission"`. Report what it says; don't retry it.
3. **GitHub Release.** The CHANGELOG section minus its heading line (see `references/release-notes.md`), written to `${W}/release-notes.md`, then `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file "${W}/release-notes.md" --latest`, or `gh release edit` if one already exists. Only now, once every feed is live.
4. **Tidy.** From the main checkout's path: `git worktree remove "${WT}"`, `git branch -D release/vX.Y.Z` and any `release-fix/*` branches this release made (each already merged and deleted on origin), `git remote prune origin`. Leave every other branch and worktree alone. Don't touch the main checkout's working tree; its local `develop` is now behind `origin/develop` by the release merges, which the summary mentions.
5. **Summary:**

   ```
   ## vX.Y.Z released
   - macOS / Linux x64 / Linux arm64 / Windows: published (run links, durations)
   - Update feeds: all four at X.Y.Z
   - Microsoft Store: submitted | skipped (<reason>)
   - Readiness: dry run skipped (<reason>) | <OSes> green (links); specs proven: <n> (links)
   - Reruns: <job, cause> or none
   - Re-tags / patch releases: <what failed, fix commit, what restarted> or none
   - Wall time: question to last feed
   - GitHub Release: <url>
   - Your main checkout's develop is behind origin/develop; `git pull` when convenient
   ```

6. Send the one-line outcome with `PushNotification` if that tool is available; the user has probably walked away.

## When you stop early

Only three things end the release before Phase 6: a Phase 0 blocker; a failure only a person can fix (the "Stop: needs a person" list in `references/ci-and-recovery.md`); or the retry budget there running out, which includes a fix that needs a product decision you can't make from the code, such as reverting a feature. Then report exactly where things stand: what failed, what you tried with run links, the state of `main`, `develop`, the tag and the release branch, which feeds published, and the next step you'd take. Leave `WT` in place so the next attempt can pick up from it.

## Safety rules

- Never force-push a branch. The only force push is the named tag during a re-tag, under the rules in `references/ci-and-recovery.md`.
- Never move a tag while any run triggered by it is still in progress.
- Never `git push --tags`. Never tag a commit whose `package.json` version differs from the tag.
- Never move a tag to a commit that changes code the users of an already-published feed run; their build of that version is final, and that's what a patch release is for.
- Never rewrite pushed commits. Never touch the main checkout's working tree or another session's worktree.
- Never run the full unit suite or a local E2E sweep. Locally, run only the test files and the single spec a fix touches.
- Never weaken a test, quarantine a spec or raise a timeout to get a run green. Fix the cause.
- No attribution trailers on any commit, and none in the GitHub Release.
