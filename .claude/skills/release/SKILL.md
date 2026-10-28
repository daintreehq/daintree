---
name: release
disable-model-invocation: true
argument-hint: "[version e.g. 0.47.0] [--dry-run | --no-dry-run]"
description: "Ship a Daintree app release end to end, unattended after one question. Confirms the version, pins develop and cuts the release branch in its own worktree, decides from stabilize and nightly evidence whether a dry run is needed, builds the changelog with parallel analyst agents over the merged PRs, merges into main and develop, tags, pushes atomically, watches the three per-OS release workflows to green, reruns infrastructure flakes, fixes real failures (on the release branch before the tag, on a branch from the tag after it) and re-tags or cuts a patch, and publishes the GitHub Release. Use when the user wants to release, ship, cut or tag a new version of the Daintree app. Not for the plugin npm packages; that is the `release-packages` skill."
---

# Release

Ship a complete gitflow release of the Daintree app. The user is involved for the first minute, while you settle the version. After that you run to the end on your own: no `AskUserQuestion`, no "shall I proceed?", no pausing for approval of the changelog, the merge, the tag or the push. Invoking this skill is the approval for all of it, including commits and pushes to the release branch, `main` and `develop`.

Autonomy isn't silence. Post a short status line at every phase change, when a long wait starts (what you're waiting on and roughly how long), and whenever something fails, is retried or recovers. Say what you did and what's next; never ask.

**Argument (may be empty):** `$ARGUMENTS`. A semver version pre-answers the version question, so you ask nothing at all. `--dry-run` forces the dry run, `--no-dry-run` skips it; without either, the evidence decides (Phase 2).

## Files

| File | Read it |
| --- | --- |
| `references/release-notes.md` | before writing any changelog text: format, voice, what's in and out, size |
| `references/changelog-pipeline.md` | at Phase 3: the collect, analyst, editor and verifier pipeline with the agent briefs |
| `references/ci-and-recovery.md` | before watching any run: the workflow map, watching, triage, rerun vs re-tag vs patch, the procedures, known traps |
| `scripts/collect-changes.mjs` | at Phase 1: PRs since the last tag, chunked for the analysts |
| `scripts/dry-run-check.mjs` | at Phase 2: which OSes, if any, need a dry run |

Paths are relative to this skill's directory, `.claude/skills/release/`. Scratch files go in `W=<scratchpad>/release-vX.Y.Z`, never in the repo.

## How the release is laid out

- **One pinned commit.** `RELEASE_SHA` is `origin/develop` at the moment the version is settled. The changelog is researched against it and the release branch is cut from it, so what was researched, validated and shipped is the same tree. PRs that merge into `develop` afterwards wait for the next release.
- **Its own worktree.** All release work happens in `WT=<repo root>/../daintree-worktrees/release-vX.Y.Z`, on `release/vX.Y.Z`. The main checkout and any other session's worktree are never touched, and `main` and `develop` are only ever updated by pushing commits built on detached `origin/main` and `origin/develop` inside `WT`.
- **Fail fast.** Every command block below starts with `set -e`. If any git command fails unexpectedly, stop that block, find out why, and only then continue. Never run the rest of a block past a failure.

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
set -e
git fetch origin
RELEASE_SHA=$(git rev-parse origin/develop)
mkdir -p "$(git rev-parse --show-toplevel)/../daintree-worktrees"
WT="$(git rev-parse --show-toplevel)/../daintree-worktrees/release-vX.Y.Z"
git worktree add -b release/vX.Y.Z "$WT" "$RELEASE_SHA"
ln -s "$(git rev-parse --show-toplevel)/node_modules" "$WT/node_modules"
git -C "$WT" push -u origin release/vX.Y.Z
```

Never run `npm ci` or `npm install` in `WT`; the symlink shares the main checkout's install. If a fix later needs a workspace package's own `node_modules`, symlink that one too.

Start the change collection now, in the background, since it takes a minute and Phase 3 needs it:

```bash
node .claude/skills/release/scripts/collect-changes.mjs --out "$W/changes" --head "$RELEASE_SHA"
```

From here on, work in `WT`.

## Phase 2: Dry run decision

```bash
node .claude/skills/release/scripts/dry-run-check.mjs --head "$RELEASE_SHA"
```

It reports whether the newest `stabilize/*` branch finished green (its branch gone from origin, its last run green, within 72 h), what landed since (PRs, shipped non-test lines, dependency or lockfile changes), and which release-pipeline files changed since the last tag without a green nightly or full dry run having built that exact content. It answers per OS. Stabilize runs check, unit, build, smoke and every E2E bucket on Linux and Windows plus a local Mac pass; the nightly packages, signs and notarizes macOS and Linux. Between them they cover nearly everything a dry run would, so the dry run is the exception, not the default.

- `"recommend": "skip"`: post the reason ("Skipping the dry run: stabilize finished green 3 h ago and 4 PRs landed since") and go on. If it lists publish-path files, say they'll first run in the tag's publish job.
- `"recommend": "dry-run"`: post the reasons and dry-run only the OSes in `oses` (`--dry-run` forces all three, `--no-dry-run` skips it; say which in the summary), on the release branch:

  ```bash
  gh workflow run release-<os>.yml --ref release/vX.Y.Z -f dry_run=true
  ```

  Resolve each run ID (`gh run list --workflow=release-<os>.yml --branch release/vX.Y.Z --event workflow_dispatch --limit 1`, checking `headSha` is the branch head) and post the URLs. It takes about two hours, Windows the longest; build the changelog (Phase 3) while it runs, then watch it to green per `references/ci-and-recovery.md`. A real failure is fixed on the release branch and the affected OSes re-dispatched on its new head, as that file describes. Don't start Phase 4 until every dispatched OS has a green dry run.

## Phase 3: Changelog

Follow `references/changelog-pipeline.md`: one analyst agent per chunk of about 40 PRs in parallel, one editor, one adversarial verifier, then you settle it. `references/release-notes.md` governs every line. The result is `$W/changelog-vX.Y.Z.md`.

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
2. Write the section into `CHANGELOG.md` directly under `# Changelog`, replacing the `## [Unreleased]` section. Date it today. If a fix made during the dry run was user-visible, add it.
3. `npx prettier --check CHANGELOG.md package.json package-lock.json`, trusting the exit code over the summary.
4. Commit `chore(release): release vX.Y.Z` with those three files only and no attribution trailers. It's the release's own bookkeeping commit, so it doesn't go through the `commit` skill.
5. Merge, tag and push, building `main` and `develop` on detached heads:

   ```bash
   set -e
   git fetch origin
   git checkout --detach origin/main
   git merge --no-ff release/vX.Y.Z -m "chore(release): merge release/vX.Y.Z into main"
   test "$(node -p "require('./package.json').version")" = "X.Y.Z"
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   MAIN=$(git rev-parse HEAD)
   git checkout --detach origin/develop
   git merge --no-ff "$MAIN" -m "chore(release): merge main into develop after vX.Y.Z release"
   DEV=$(git rev-parse HEAD)
   git push --atomic origin "$MAIN:refs/heads/main" "$DEV:refs/heads/develop" "refs/tags/vX.Y.Z"
   ```

   `--atomic` means `main`, `develop` and the tag land together or not at all, so the tag can never trigger a release whose `main` was rejected.

   - **The develop merge conflicts in `CHANGELOG.md`** when PRs added `## [Unreleased]` entries after the pin. Keep `develop`'s `## [Unreleased]` heading with only the entries that aren't in the new release section, then the new `## [X.Y.Z]` section, then every older section in order. Other conflicts mean `develop` and the release branch both changed a file since the pin; keep `develop`'s side unless the release branch's change was a release fix, in which case keep both.
   - **The push is rejected** because `main` or `develop` moved on origin: `git tag -d vX.Y.Z`, then run the block again from the top. Never force it.

6. `git push origin --delete release/vX.Y.Z`. Then post: "Tagged vX.Y.Z; main, develop and the tag pushed together."

Resolve the three tag-triggered run IDs (`gh run list --workflow=<wf> --event push --limit 3`, matching `headBranch == vX.Y.Z` and the tag's commit) and post their URLs. A clean tag run takes about two hours: Linux about 1h10, macOS and Windows near 2h.

## Phase 5: Watch to green

Watch the three runs per `references/ci-and-recovery.md`, staying in the turn, and track the four update feeds separately (`latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`, `latest.yml` for Windows): Linux publishes x64 then arm64, and either can fail alone. Post a line as each finishes ("Linux x64 and arm64 published in 1h08; macOS in E2E, Windows building").

On a failure, triage it per that file: rerun an infrastructure flake; fix a real failure on a branch cut from the tag, then re-tag or cut a patch release as its decision table says; stop for the few things only a person can fix (an expired Apple agreement, an expired certificate). Keep going until all four feeds carry `vX.Y.Z` (or its patch) or the retry budget is spent.

## Phase 6: Wrap up

1. **Verify the feeds.** For each of the four files, `curl -fsS "https://updates.daintree.org/releases/<file>?t=$(date +%s)"` reports `version: X.Y.Z`.
2. **Note the Microsoft Store step.** It reports as a warning, never a failure, and has skipped on every release so far because its secrets aren't configured: `gh run view <windows run> --log | grep -i "Microsoft Store submission"`. Report what it says; don't retry it.
3. **GitHub Release.** The CHANGELOG section minus its heading line (see `references/release-notes.md`), written to `$W/release-notes.md`, then `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file "$W/release-notes.md" --latest`, or `gh release edit` if one already exists. Only now, once every feed is live.
4. **Tidy.** From the main checkout's path: `git worktree remove "$WT"`, `git branch -D release/vX.Y.Z` and any `release-fix/*` branches this release made (each already merged and deleted on origin), `git remote prune origin`. Leave every other branch and worktree alone. Don't touch the main checkout's working tree; its local `develop` is now behind `origin/develop` by the release merges, which the summary mentions.
5. **Summary:**

   ```
   ## vX.Y.Z released
   - macOS / Linux x64 / Linux arm64 / Windows: published (run links, durations)
   - Update feeds: all four at X.Y.Z
   - Microsoft Store: submitted | skipped (<reason>)
   - Dry run: skipped (<reason>) | <OSes> green (links)
   - Reruns: <job, cause> or none
   - Re-tags / patch releases: <what failed, fix commit, what restarted> or none
   - GitHub Release: <url>
   - Your main checkout's develop is behind origin/develop; `git pull` when convenient
   ```

6. Send the one-line outcome with `PushNotification` if that tool is available; the user has probably walked away.

## When you stop early

Only three things end the release before Phase 6: a Phase 0 blocker; a failure only a person can fix (the "Stop: needs a person" list in `references/ci-and-recovery.md`); or the retry budget there running out, which includes a fix that needs a product decision you can't make from the code, such as reverting a feature. Then report exactly where things stand: what failed, what you tried with run links, the state of `main`, `develop`, the tag and the release branch, which feeds published, and the next step you'd take. Leave `WT` in place so the next attempt can pick up from it.

## Safety rules

- Never force-push a branch. The only force push is the named tag during a re-tag, under the rules in `references/ci-and-recovery.md`.
- Never `git push --tags`. Never tag a commit whose `package.json` version differs from the tag.
- Never move a tag to a commit that changes code the users of an already-published feed run; their build of that version is final, and that's what a patch release is for.
- Never rewrite pushed commits. Never touch the main checkout's working tree or another session's worktree.
- Never run the full unit suite or a local E2E sweep. CI is the gate; locally, run only the test files a fix touches.
- Never weaken a test, quarantine a spec or raise a timeout to get a run green. Fix the cause.
- No attribution trailers on any commit, and none in the GitHub Release.
