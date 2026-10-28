# CI and recovery

How the release workflows fit together, how to wait on them, how to get from a red job to a proven fix quickly, and how to restart once.

## The three workflows

`release-macos.yml`, `release-linux.yml` and `release-windows.yml` each run a full vertical slice for one OS, triggered by a `v*` tag push or by `workflow_dispatch` with `dry_run=true`. They are independent: each publishes the moment its own run is green.

| OS | Job chain (timeout) | Notes |
| --- | --- | --- |
| macOS | `checks` (30m, ubuntu), `unit-tests` (two shards, 40m, macos-15) and `perf-liveness` (30m) → `e2e-core-gate` + `e2e-full-gate` (reusable `e2e.yml`, seven `full-*` buckets sharded) → `build-daintree` (90m: universal build, sign, notarize, staple, packaged smoke) → `publish-daintree` (15m) | Only about five macOS jobs run at once, so macOS is the long pole |
| Linux | `checks` + `unit-tests` (two shards, 40m) + `perf-liveness` → E2E gates → `build-daintree` (x64 + arm64 native runners) → `smoke-packaged` → `publish-daintree` | Separate `latest-linux.yml` and `latest-linux-arm64.yml` feeds |
| Windows | `checks` + `unit-tests` (two shards, 60m, windows-2022) + `perf-liveness` → E2E gates (8–12 shards) → `build-daintree-x64` + `build-daintree-arm64` → `assemble-windows-release` → `smoke-packaged` → publish | The Store submission step inside `build-daintree-x64` has been skipped on every release so far: the `PARTNER_CENTER_*` and `STORE_PRODUCT_ID` secrets aren't configured |

A clean run takes about 1h10 on Linux and close to two hours on macOS and Windows; a dry run takes the same minus publishing. The unit suite is sharded in two and the perf scenario liveness test (6–8 minutes alone) runs in its own job since v0.47.0, when the single unit job outgrew its 40 minutes with every test passing.

What publishing does (`.github/actions/publish-daintree`): checks the version is strictly greater than the live feed (`scripts/ci/check-version-monotonic.mjs`), uploads binaries to R2 first, verifies them, uploads the `latest*.yml` metadata last with no-cache headers, verifies the metadata at the CDN edge, then notifies the website. Two consequences that shape every recovery decision:

- **An OS that already published a version never republishes it.** The monotonic gate treats an equal live version as "already published" and skips the upload (the website webhook still fires, harmlessly). Re-tagging can't replace an OS's published build.
- **Dry runs publish nothing.** `publish-daintree` requires a tag ref and `dry_run != true`; the Store submission requires `dry_run != true`. Signing and notarization do run in a dry run, on purpose.

Concurrency: each workflow's group is `release-<os>-<ref>-release` for tag runs (`cancel-in-progress: false`), so a second run on the same tag queues behind the first. Dry runs get a unique group per run.

Permissions: all three call the reusable `e2e.yml`, and a reusable workflow can't escalate beyond its caller. If `e2e.yml` declares a permission a caller lacks, that caller fails with `startup_failure` in 0 seconds with no jobs. The three `permissions` blocks are deliberately identical and must be a superset of everything `e2e.yml` declares.

## Waiting

Stay in the turn; never end it to wait. Wait in the foreground (Bash timeout 600000), repeated until it exits 0:

```bash
node .claude/skills/release/scripts/watch-runs.mjs --runs <id>,<id>,<id> --minutes 9 --version X.Y.Z
```

It polls every 45 seconds, bounds every request, retries API and network errors instead of reporting them as failures, and prints each run's job progress, its failed or cancelled jobs and the four feeds. Exit 0: every run is terminal. Exit 4: a job failed or was cancelled since the call started; triage it now while the runs carry on, then keep watching. Exit 3: the window ended; call it again. If it reports the API unreachable for half an hour straight, stop and report where things stand rather than waiting blind.

Track publication per feed, not per OS. There are four: `latest-mac.yml`, `latest-linux.yml` (x64), `latest-linux-arm64.yml` and `latest.yml` (Windows). Linux's publish job uploads x64 and then arm64, so one can be live while the other failed. Read all four before every recovery decision; the choice depends on them.

## Triage

The moment `watch-runs.mjs` shows a failed job:

```bash
node .claude/skills/release/scripts/run-failures.mjs --run <id> --out "${W}/failures"
```

It works while the run is still going. For each job of the latest attempt that failed, hit its timeout or never got a runner, it says why it ended (a job that hits `timeout-minutes` reports `cancelled`, as does one GitHub never assigned a runner; the script tells them apart from the annotations) and then:

- **Unit jobs:** the vitest failure blocks and summary, and the slowest test files. A summary showing every test passed in a job that hit its timeout means the job ran out of time, not that a test failed.
- **E2E jobs:** every failed or flaky test from the shard's Playwright report for that attempt, with `file:line`, how many attempts failed, the first lines of the error, and local paths to its screenshots and `error-context.md`. Open the screenshots before forming a theory: v0.47.0's drop-target failure was obvious from one screenshot (the drag source had wrapped below the fold), after a long detour through logs.
- **Anything else:** the 40 log lines before the error.

`--job <id>` analyses one job whatever its outcome, for the slowest files of a green unit job.

Jobs cancelled because a dependency failed, or by a person, are listed together at the end and need nothing.

Then sort each failure into one of the kinds below.

### Infrastructure: rerun

The failure isn't about the code. Wait for the run to finish (a job can't be rerun while its run is in progress), then `gh run rerun <id> --failed` and watch again. Never re-tag for one of these.

| Signature | Where |
| --- | --- |
| `stapler validate` or `stapler staple` fails with -1005 / "network connection lost" / exit 68, or `notarytool` network errors after the submission was Accepted | macOS `build-daintree` (the step already retries with backoff; a failure that survives that is still Apple's side) |
| "Repair Claude Code native binary" fails before any test runs (`npm install -g @anthropic-ai/claude-code` skipped `claude-code-win32-x64`) | Windows E2E shards |
| Runner lost communication, provisioning failed, "The job was not acquired by Runner of type hosted even after multiple attempts" (macOS arm64 capacity; v0.47.0), "The operation was canceled" with no failing step, `npm ci` or artifact download network errors, GitHub API 5xx | any |
| Packaged smoke "Renderer + IPC checks timed out" (v0.38, v0.39, v0.44; a rerun fixed it every time) | macOS `build-daintree` |
| A unit test that has flaked before (focus, timers, file watchers: v0.42's IssuePickerDialog, plugin-ui kit, TopologyWatcher), or a real-timer or 15 s per-test timeout on a slow Windows runner (v0.47.0: `ptyFlowControl` flush cadence, `paneToolbarStyles.contract`), failing on one OS and passing on the others and in that OS's previous run | `unit-tests` |
| One E2E test failed on one OS after Playwright's own retries, with nothing in the error or screenshot pointing at the product, and it passed in stabilize, a readiness proof or the other OSes. `rerun --failed` on a shard reruns only the specs that failed | E2E shards |

Rerun the same job at most twice. A third failure with the same signature is real. A unit job that hit its timeout is not a flake when its summary shows the suite simply ran long: the suite has outgrown the job (see Known traps).

### Stop: needs a person

Some failures no rerun or code change can fix. Stop and report (SKILL.md "When you stop early"):

- Notarization rejected with **403 "required agreement missing or expired"**: someone has to accept the updated Apple Developer agreement. Once they say it's signed, `gh run rerun <id> --failed` picks up where it stopped.
- Signing certificate or API key expired or revoked (`errSecInternalComponent` that persists across a rerun, "certificate has expired", `notarytool` 401).
- A secret missing or rejected for R2 or the website webhook.

### Real: fix it

A deterministic test failure, typecheck, lint or format failure, a spec failing every attempt, a build or packaging error the code caused, a job that outgrew its timeout, a workflow config error (`startup_failure`; see Permissions above). Check Known traps first; most real release failures so far were one of them.

## Reproduce locally

A fix pushed blind costs an hour per guess. Before pushing one, make the failure happen where you can iterate, and make it pass there. `FIX_REF` below is the branch holding the fix: `release/vX.Y.Z` before the tag, `release-fix/vX.Y.Z` after it.

- **Unit tests:** `npm test -- <the failing files>` in `WT`, on the fix branch. That's always possible; a macOS-only failure that passes locally gets a throwaway branch with a minimal workflow running that one file on `macos-15` (how the v0.46.0 fake-timer hang was found in two five-minute runs).
- **An E2E failure that isn't about the runner** (the product did the wrong thing, a wrong selector, a race the error points at): run that one spec locally. This skill authorizes exactly that, one spec and never a bucket: `npm run build:e2e` in `WT` before the first local reproduction and again after any `src/`, `electron/` or `shared/` change (spec edits under `e2e/` are live), then `npx playwright test <file> --project=<suite> --retries=0`. Never while the user's own Daintree is being rebuilt underneath them; the build goes into `WT` only.
- **An E2E failure tied to the runner** (window size, screen, OS, GPU, timing only seen there): prove the fix on that OS with `gh workflow run e2e-single.yml --ref "${FIX_REF}" -f platform=<os> -f suite=<bucket> -f test_file=<spec> -f retries=0`, watched to green after checking the run's `headSha` is the fix commit. It takes 10 to 15 minutes.
- **Workflow changes** (sharding, a new job): check the YAML parses (`node -e 'require("yaml").parse(require("fs").readFileSync(".github/workflows/<file>","utf8"))'`) and run the exact command the job will run locally, on a small directory where the full suite would be too much (`npm run test -- --shard=1/2 src/utils/__tests__` and `--shard=2/2` must add up to the directory).

## Restart: one restart, carrying every fix

1. **Let every run of the release finish.** Keep triaging and fixing while they run, but don't restart anything until every run on the tag is terminal. A failed run can't publish, but its remaining jobs keep finding failures, and the restart has to carry all of them. Never move the tag while any run on it is still going, even a passing one that has nearly published: its later jobs check out the tag by ref and refuse the moved commit (v0.47.0's Windows `assemble-windows-release` died that way after both builds passed, costing Windows a second two-hour run).
2. **Put every fix on one branch.** Before the tag (a readiness proof or dry run failed), that's `release/vX.Y.Z` itself. After the tag, cut one from it: `git checkout -b release-fix/vX.Y.Z vX.Y.Z`. Each fix is committed through the `commit` skill (it pushes the branch). One branch means `main` receives the fixes and nothing else from `develop`.
3. **Prove every fix** as "Reproduce locally" says, before restarting.
4. **Read all four feeds**, then pick the restart:

| Situation | Do |
| --- | --- |
| Dry run failed | Re-dispatch on the release branch's new head every OS whose gates the fix can reach: just the failing OS for a fix in code or tests that only run there; every dispatched OS for a change to shared tests, E2E helpers, workflows, dependencies or packaging. |
| Tag run failed, **no feed has published** `vX.Y.Z` | Re-tag. |
| Tag run failed, some feeds published, and the fix touches only tests, CI, or code that runs only on the unpublished feeds' platforms | Re-tag. Each OS whose feeds are all published gets its new run cancelled: it would rebuild and then skip the upload. |
| Tag run failed, some feeds published, and the fix changes code the published feeds' users run | Patch release. Their `vX.Y.Z` is final. |

`release-windows.yml` also has a `force_publish` dispatch input that publishes from a branch, used once for v0.39.0. Don't use it: the shipped binaries then come from a commit the tag doesn't point at.

### Re-tag

In `WT`, with every fix proven on `release-fix/vX.Y.Z` and every old run terminal:

```bash
set -euo pipefail
git fetch origin
git checkout --detach origin/main
git merge --no-ff release-fix/vX.Y.Z -m "chore(release): merge release fix into main for vX.Y.Z"
test "$(node -p "require('./package.json').version")" = "X.Y.Z"
git tag -f -a vX.Y.Z -m "Release vX.Y.Z"
MAIN=$(git rev-parse HEAD)
git checkout --detach origin/develop
git merge --no-ff "${MAIN}" -m "chore(release): merge release fix for vX.Y.Z into develop"
DEV=$(git rev-parse HEAD)
git push --atomic origin "${MAIN}:refs/heads/main" "${DEV}:refs/heads/develop" "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z" > "${W}/push.log" 2>&1 || { cat "${W}/push.log"; exit 1; }
test "$(git ls-remote origin "refs/tags/vX.Y.Z^{}" | cut -f1)" = "${MAIN}"
git push origin --delete release-fix/vX.Y.Z
```

The `+` forces only the named tag; `main` and `develop` stay fast-forward-only, and `--atomic` moves all three or none. Never `--tags --force`. A rejected push means `main` or `develop` moved: run the block again from the top.

The tag push starts three fresh runs on the new commit. Resolve their IDs (`gh run list --workflow=<wf> --event push --limit 3`, matching `headBranch == vX.Y.Z` and `headSha == ${MAIN}`), cancel the run of any OS whose feeds are all published, and watch the rest. Never rerun an old run after a re-tag: a rerun keeps its original commit, which the tag no longer points at. Post what failed, the fix commits, and what restarted.

### Patch release

A gitflow hotfix: `X.Y.(Z+1)` is `X.Y.Z` plus the fix and nothing else from `develop`. No question to the user; the version is determined.

1. With every `vX.Y.Z` run terminal and `vX.Y.Z` left where it is, on `release-fix/vX.Y.Z` in `WT`: `npm version X.Y.(Z+1) --no-git-tag-version`, and add a short `CHANGELOG.md` section above `## [X.Y.Z]`: an intro saying what was wrong with `X.Y.Z` and on which platforms, and the fix under Bug Fixes. Commit `chore(release): release vX.Y.(Z+1)`.
2. Run the Phase 4 step 5 block from SKILL.md with `release-fix/vX.Y.Z` in place of `release/vX.Y.Z` and `X.Y.(Z+1)` as the version. The develop merge resolves `CHANGELOG.md` the same way: `develop`'s Unreleased entries first, then `X.Y.(Z+1)`, then `X.Y.Z` and the rest in order. Then delete the fix branch on origin.
3. Watch all three runs as in Phase 5. Every feed takes the patch, including those already on `X.Y.Z`, since it's a greater version; a feed that never got `X.Y.Z` goes straight to `X.Y.(Z+1)`, which the monotonic gate allows.
4. Create GitHub Releases for both versions; the `X.Y.Z` notes stay as written.

## Retry budget

One restart is the plan. A second is allowed only for a failure the first could not have carried (it lives in a job the failed runs never reached); three is the hard limit, counting re-tags, patch releases and dry-run fix cycles together. Reruns of infrastructure failures don't count, but any one job gets two at most. Every restart past the first is reported with the failure and why the earlier one couldn't have caught it. When the budget runs out, or a fix needs a product decision you can't make from the code (reverting a feature, changing what ships), stop and report per SKILL.md "When you stop early".

## Known traps

These came out of real releases. Check them before investigating from scratch.

- **macos-15 runners have a fixed 1024x768 screen.** Electron clamps windows to it, so specs that assume a large window, two wide panes, three panes in one row, or fixed `setBounds` sizes fail only on macOS release runs (PR CI runs no E2E; stabilize covers macOS only with a local pass on a big screen). A third grid pane wraps below the fold, and a Playwright `dragTo` between panes then scrolls the grid mid-drag and the drop never lands (v0.47.0). Keep two panes in view, use `waitForTerminalTextIgnoringLineBreaks` for wrappable terminal text, print markers through `node -e` with the string split so the echoed command can't match, and keep window sizes within about 900x600. Readiness proves new and changed specs on macos-15 before the tag for this reason.
- **The unit suite outgrows its job.** It grew from 3,495 to 4,191 files between v0.46.0 and v0.47.0, and the single Linux unit job finished every test at 38m18s, a second past its budget once setup was counted. Readiness checks headroom from the last release; the fix is more shards or a faster slow file, never a higher timeout.
- **Fake `setTimeout` across real localhost HTTP hangs on macOS only.** `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` while clients connect over 127.0.0.1 times out at 15 s every run on macos-15 and passes everywhere else. Fix with `shouldAdvanceTime: true`.
- **Release runs are the only macOS unit-test runs.** `develop` CI is Ubuntu-only, so a macOS-only unit failure first appears here.
- **Runner image changes break toolchains.** v0.39.0's Windows arm64 build failed twice because `node-gyp` stopped finding Visual Studio after an image update, and v0.45.0's macOS failures came from the move to `macos-15` that same day. When a build or install step fails on something the code didn't change, compare the runner image version in the job's "Set up job" log with the last green release run before blaming the code; the fix goes in the workflow.
- **A moved tag breaks runs still in flight.** Jobs that check out the tag later in a run (Windows `assemble-windows-release`) refuse it once a re-tag has moved it. Re-tag only when every run on the tag is terminal.
- **zsh modifiers in refspecs.** `"$MAIN:refs/heads/main"` is `$MAIN` with the `:r` modifier in zsh. Always brace: `"${MAIN}:refs/heads/main"`.
- **A pipe hides a failed push.** `git push … | tail` exits 0 when the push fails, and the next line (deleting a branch) runs anyway. Push to a log file and check the exit code, then confirm with `ls-remote`.
- **`gh run watch` exits on a dropped connection** with a non-zero code that reads as a failed run. Use `watch-runs.mjs`.
- **A job that hits its timeout reports `cancelled`, not `failure`**, so a filter on `conclusion == "failure"` misses it. `run-failures.mjs` reads the annotation.
- **`rtk` output lies.** It truncates `git log` and summarises tool output; use `rtk proxy` for anything you'll base a decision on.
