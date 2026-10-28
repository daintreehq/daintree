# CI and recovery

How the release workflows fit together, how to watch them without ending the turn, and what to do when one fails.

## The three workflows

`release-macos.yml`, `release-linux.yml` and `release-windows.yml` each run a full vertical slice for one OS, triggered by a `v*` tag push or by `workflow_dispatch` with `dry_run=true`. They are independent: each publishes the moment its own run is green.

| OS | Job chain (timeout) | Notes |
| --- | --- | --- |
| macOS | `checks` (30m, ubuntu) and `unit-tests` (40m, macos-15) → `e2e-core-gate` + `e2e-full-gate` (reusable `e2e.yml`, seven `full-*` buckets sharded) → `build-daintree` (90m: universal build, sign, notarize, staple, packaged smoke) → `publish-daintree` (15m) | Only about five macOS jobs run at once; the unit-test job runs close to its 40-minute limit |
| Linux | `checks` + `unit-tests` (40m) → E2E gates → `build-daintree` (x64 + arm64 native runners) → `smoke-packaged` → `publish-daintree` | Separate `latest-linux.yml` and `latest-linux-arm64.yml` feeds |
| Windows | `checks` + `unit-tests` (60m, windows-2022) → E2E gates (8–12 shards) → `build-daintree-x64` + `build-daintree-arm64` → `assemble-windows-release` → `smoke-packaged` → publish | The Store submission step inside `build-daintree-x64` has been skipped on every release so far: the `PARTNER_CENTER_*` and `STORE_PRODUCT_ID` secrets aren't configured |

A clean run takes about 1h10 on Linux, 1h55 on macOS and 2h05 on Windows (v0.43.0), and a dry run the same minus publishing. Releases v0.37.0–v0.46.0 took 2h05 to 7h18 from first tag push to the last OS green; every hour above about 2h10 went on re-tags and reruns.

What publishing does (`.github/actions/publish-daintree`): checks the version is strictly greater than the live feed (`scripts/ci/check-version-monotonic.mjs`), uploads binaries to R2 first, verifies them, uploads the `latest*.yml` metadata last with no-cache headers, verifies the metadata at the CDN edge, then notifies the website. Two consequences that shape every recovery decision:

- **An OS that already published a version never republishes it.** The monotonic gate treats an equal live version as "already published" and skips the upload (the website webhook still fires, harmlessly). Re-tagging can't replace an OS's published build.
- **Dry runs publish nothing.** `publish-daintree` requires a tag ref and `dry_run != true`; the Store submission requires `dry_run != true`. Signing and notarization do run in a dry run, on purpose.

Concurrency: each workflow's group is `release-<os>-<ref>-release` for tag runs (`cancel-in-progress: false`), so a second run on the same tag queues behind the first. Dry runs get a unique group per run.

Permissions: all three call the reusable `e2e.yml`, and a reusable workflow can't escalate beyond its caller. If `e2e.yml` declares a permission a caller lacks, that caller fails with `startup_failure` in 0 seconds with no jobs. The three `permissions` blocks are deliberately identical and must be a superset of everything `e2e.yml` declares.

## Watching runs

Stay in the turn; never end it to wait. Start one background watcher per run (`run_in_background: true`):

```bash
o="$W/run-<id>"; rm -f "$o.exit"
gh run watch <id> --exit-status --interval 60 >"$o.out" 2>&1; echo $? >"$o.exit"
```

and wait in the foreground with a bounded loop (Bash timeout 600000), repeated until every watcher has an `.exit` file:

```bash
end=$((SECONDS+540)); until { [ -f "$W/run-<a>.exit" ] && [ -f "$W/run-<b>.exit" ] && [ -f "$W/run-<c>.exit" ]; } || [ $SECONDS -ge $end ]; do sleep 30; done
```

Between waits, look for jobs that already failed, so triage starts while the rest of the run is still going:

```bash
gh run view <id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | .name'
```

On a big run the jobs API sometimes returns 502; paging still works: `gh api "repos/daintreehq/daintree/actions/runs/<id>/jobs?filter=latest&per_page=20&page=<n>"`.

Track publication per feed, not per OS. There are four: `latest-mac.yml`, `latest-linux.yml` (x64), `latest-linux-arm64.yml` and `latest.yml` (Windows). Linux's publish job uploads x64 and then arm64, so one can be live while the other failed. A feed is published once `curl -fsS "https://updates.daintree.org/releases/<feed>?t=$(date +%s)"` shows `version: X.Y.Z`. Read all four before every recovery decision; the choice depends on them.

## Triage

Read before acting: the failed job and step names, then `gh run view <id> --log-failed | tail -300` (or `gh run view --job <job-id> --log` for one job). Sort the failure into one of two kinds.

### Infrastructure: rerun

The failure isn't about the code. Wait for the run to finish (a job can't be rerun while its run is in progress), then `gh run rerun <id> --failed` and watch again.

| Signature | Where |
| --- | --- |
| `stapler validate` or `stapler staple` fails with -1005 / "network connection lost" / exit 68, or `notarytool` network errors after the submission was Accepted | macOS `build-daintree` (the step already retries with backoff; a failure that survives that is still Apple's side) |
| "Repair Claude Code native binary" fails before any test runs (`npm install -g @anthropic-ai/claude-code` skipped `claude-code-win32-x64`) | Windows E2E shards |
| A job hit its `timeout-minutes` once (macOS `unit-tests` normally takes 27–31 of 40; runner speed varies a lot) | any |
| Runner lost communication, provisioning failed, "The operation was canceled" with no failing step, `npm ci` or artifact download network errors, GitHub API 5xx | any |
| Packaged smoke "Renderer + IPC checks timed out" (v0.38, v0.39, v0.44; a rerun fixed it every time) | macOS `build-daintree` |
| A unit test that has flaked before (focus, timers, file watchers: v0.42's IssuePickerDialog, plugin-ui kit, TopologyWatcher) failing on one OS and passing on the others | `unit-tests` |
| One E2E test failed on one OS after Playwright's own retries, with nothing in the log pointing at the product, and it passed in stabilize or the dry run. `rerun --failed` on a shard reruns only the specs that failed | E2E shards |

Rerun the same job at most twice. A third failure with the same signature is real.

### Stop: needs a person

Some failures no rerun or code change can fix. Stop and report (SKILL.md "When you stop early"):

- Notarization rejected with **403 "required agreement missing or expired"**: someone has to accept the updated Apple Developer agreement. v0.41.0's dry run hit this two days before the tag and nobody acted on it. Once they say it's signed, `gh run rerun <id> --failed` picks up where it stopped.
- Signing certificate or API key expired or revoked (`errSecInternalComponent` that persists across a rerun, "certificate has expired", `notarytool` 401).
- A secret missing or rejected for R2 or the website webhook.

### Real: fix it

A deterministic test failure, typecheck, lint or format failure, a spec failing the same way twice, a build or packaging error the code caused, a workflow config error (`startup_failure`; see Permissions above).

1. Find the cause in the log and the code. Check the known traps below first.
2. Fix the cause in `WT`; never weaken a test, quarantine a spec, or raise a timeout to get past a single overrun. Where the fix goes depends on whether the release is tagged yet:
   - **Dry run (not tagged):** on `release/vX.Y.Z`, committed through the `commit` skill, which pushes the branch. It reaches `main` and `develop` with the release merge.
   - **Tag run:** on a branch cut from the tag, so `main` receives the fix and nothing else: `git checkout -b release-fix/vX.Y.Z-<slug> vX.Y.Z`, fix, commit through the `commit` skill (it pushes the branch). Every past re-tag merged all of `develop` into `main` instead and shipped whatever else had landed meanwhile (v0.38.0 picked up two unrelated changes that way).
3. Prove the fix before restarting anything, because every restart costs an hour or more. `FIX_REF` is the branch the fix is on.
   - Unit tests: `npm test -- <the failing files>` locally in `WT`.
   - E2E: `gh workflow run e2e-single.yml --ref "$FIX_REF" -f platform=<os> -f suite=<bucket> -f test_file=<spec> -f retries=0`, watched to green, after checking the run's `headSha` is the fix commit. The bucket and spec are in the failed job's name and log.
   - A macOS-only unit failure that passes locally: push a throwaway branch with a minimal workflow running that one file on `macos-15`, watch it, delete the branch. That's how the v0.46.0 fake-timer hang was found in two five-minute runs after local attempts got nowhere.
4. Restart, per the decision below.

## Restart: re-dispatch, re-tag or patch

Before choosing, settle the state: wait for every run of the failing release to reach a terminal state (cancel any still going with `gh run cancel <id>` and wait until it reports `completed`), then read all four feeds. A run that already passed its checkout can still be uploading, so a decision made while it runs can be wrong by the time it lands.

| Situation | Do |
| --- | --- |
| Dry run failed | Re-dispatch on the release branch's new head every OS whose gates the fix can reach: just the failing OS for a fix in code or tests that only run there; every dispatched OS for a change to shared tests, E2E helpers, workflows, dependencies or packaging. |
| Tag run failed, **no feed has published** `vX.Y.Z` | Re-tag. |
| Tag run failed, some feeds published, and the fix touches only tests, CI, or code that runs only on the unpublished feeds' platforms | Re-tag. Each OS whose feeds are all published gets its new run cancelled: it would rebuild and then skip the upload. |
| Tag run failed, some feeds published, and the fix changes code the published feeds' users run | Patch release. Their `vX.Y.Z` is final. |

`release-windows.yml` also has a `force_publish` dispatch input that publishes from a branch, used once for v0.39.0. Don't use it: the shipped binaries then come from a commit the tag doesn't point at.

### Re-tag

In `WT`, with the fix proven on `release-fix/vX.Y.Z-<slug>` and every old run terminal:

```bash
set -e
git fetch origin
git checkout --detach origin/main
git merge --no-ff release-fix/vX.Y.Z-<slug> -m "chore(release): merge release fix into main for vX.Y.Z"
test "$(node -p "require('./package.json').version")" = "X.Y.Z"
git tag -f -a vX.Y.Z -m "Release vX.Y.Z"
MAIN=$(git rev-parse HEAD)
git checkout --detach origin/develop
git merge --no-ff "$MAIN" -m "chore(release): merge release fix for vX.Y.Z into develop"
DEV=$(git rev-parse HEAD)
git push --atomic origin "$MAIN:refs/heads/main" "$DEV:refs/heads/develop" "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"
git push origin --delete release-fix/vX.Y.Z-<slug>
```

The `+` forces only the named tag; `main` and `develop` stay fast-forward-only, and `--atomic` moves all three or none. Never `--tags --force`. A rejected push means `main` or `develop` moved: run the block again from the top.

The tag push starts three fresh runs on the new commit. Resolve their IDs (`gh run list --workflow=<wf> --event push --limit 3`, matching `headBranch == vX.Y.Z` and `headSha == $MAIN`), cancel the run of any OS whose feeds are all published, and watch the rest. Never rerun an old run after a re-tag: a rerun keeps its original commit, which the tag no longer points at. Post what failed, the fix commit, and what restarted.

### Patch release

A gitflow hotfix: `X.Y.(Z+1)` is `X.Y.Z` plus the fix and nothing else from `develop`. No question to the user; the version is determined.

1. With every `vX.Y.Z` run terminal and `vX.Y.Z` left where it is, on `release-fix/vX.Y.Z-<slug>` in `WT`: `npm version X.Y.(Z+1) --no-git-tag-version`, and add a short `CHANGELOG.md` section above `## [X.Y.Z]`: an intro saying what was wrong with `X.Y.Z` and on which platforms, and the fix under Bug Fixes. Commit `chore(release): release vX.Y.(Z+1)`.
2. Run the Phase 4 step 5 block from SKILL.md with `release-fix/vX.Y.Z-<slug>` in place of `release/vX.Y.Z` and `X.Y.(Z+1)` as the version. The develop merge resolves `CHANGELOG.md` the same way: `develop`'s Unreleased entries first, then `X.Y.(Z+1)`, then `X.Y.Z` and the rest in order. Then delete the fix branch on origin.
3. Watch all three runs as in Phase 5. Every feed takes the patch, including those already on `X.Y.Z`, since it's a greater version; a feed that never got `X.Y.Z` goes straight to `X.Y.(Z+1)`, which the monotonic gate allows.
4. Create GitHub Releases for both versions; the `X.Y.Z` notes stay as written.

## Retry budget

Up to three restarts per release, counting re-tags, patch releases and dry-run fix cycles together, and two reruns of any one job. When that runs out, or a fix needs a product decision you can't make from the code (reverting a feature, changing what ships), stop and report per SKILL.md "When you stop early".

## Known traps

These came out of real releases. Check them before investigating from scratch.

- **macos-15 runners have a fixed 1024x768 screen.** Electron clamps windows to it, so specs that assume a large window, two wide panes or fixed `setBounds` sizes fail only on macOS release runs (PR CI runs no E2E; stabilize skips macOS on CI). v0.45.0 needed two re-tags for four such specs. Use `waitForTerminalTextIgnoringLineBreaks` for wrappable terminal text, print markers through `node -e` with the string split so the echoed command can't match, and keep window sizes within about 900x600.
- **Fake `setTimeout` across real localhost HTTP hangs on macOS only.** `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` while clients connect over 127.0.0.1 times out at 15 s every run on macos-15 and passes everywhere else. Fix with `shouldAdvanceTime: true`.
- **Release runs are the only macOS unit-test runs.** `develop` CI is Ubuntu-only, so a macOS-only unit failure first appears here.
- **Runner image changes break toolchains.** v0.39.0's Windows arm64 build failed twice because `node-gyp` stopped finding Visual Studio after an image update, and v0.45.0's macOS failures came from the move to `macos-15` that same day. When a build or install step fails on something the code didn't change, compare the runner image version in the job's "Set up job" log with the last green release run before blaming the code; the fix goes in the workflow.
- **A timeout raise isn't worth a re-tag.** Rerun the job; re-tag for a timeout only when the same job overran twice, and then because the job really got slower.
- **`rtk` output lies.** It truncates `git log` and summarises tool output; use `rtk proxy` for anything you'll base a decision on.
