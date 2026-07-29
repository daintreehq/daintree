# E2E Testing

Daintree uses [Playwright](https://playwright.dev/) for end-to-end testing of the Electron app.

## Setup

Playwright is installed as a dev dependency (`@playwright/test`). No browser download is needed — tests launch the real Electron binary directly.

## Running Tests

```bash
npm run test:e2e                   # Run every Playwright project
npm run test:e2e:core              # Lightweight release-gating smoke
npm run test:e2e:full              # Run all seven full-* buckets
npm run test:e2e:full-terminal     # Run a single bucket — substitute any of:
                                   #   full-terminal full-worktree full-presets
                                   #   full-platform full-panels full-resilience
                                   #   full-plugins
npm run test:e2e:online            # Claude/OpenCode-dependent online tests
npm run test:e2e:nightly           # Memory-leak / soak suite (serialized, workers=1)
npm run test:e2e:demo              # Demo-engine specs (workers=1, screencast capture)
npx playwright test e2e/full/terminal/core-terminal-search.spec.ts  # Single file
PWDEBUG=1 npx playwright test --project=core                         # Debug mode
```

## Test Suites

Tests are split into twelve Playwright projects:

- **core** — Lightweight deterministic release-gate smoke (5 specs). This is the Playwright e2e smoke suite (`npm run test:e2e:core`), distinct from the Electron stability soak (`npm run test:smoke`). See [test:smoke vs Playwright core](#testsmoke-vs-playwright-core) below.
- **full-terminal** — PTY mechanics, scrollback, search, layout, recipes, output flood, context injection, fleet broadcast.
- **full-worktree** — Worktree lifecycle, project switching, git detection, cross-project flows.
- **full-presets** — Agent presets, recipes, onboarding, CCR.
- **full-platform** — Settings, persistence, a11y, keyboard, OS-shell surfaces, oauth, security.
- **full-panels** — Browser, dev-preview, portal, review hub, file viewer, drag-drop, action palette, toolbar chrome.
- **full-resilience** — Errors, IPC, crashes, races, perf budgets, diagnostics.
- **full-plugins** — Plugin manager UI, plugin lifecycle (enable/disable, restart gating), and manifest contribution rendering against the sideloaded sample plugin.
- **online** — Tests that interact with real agent CLIs (requires `ANTHROPIC_API_KEY`).
- **nightly** — Long-running memory-leak detection (workers=1, no retries). The project name predates the scheduled nightly; it now runs as part of the `stabilize` sweep and on demand, not on a cron.
- **screenshots** — Marketing screenshot pipeline. Run on demand via `screenshots.yml`, not part of the PR/release gates.
- **demo** — Demo-engine specs that exercise the in-app demo automation API (`window.electron.demo`) — screencast recording and scripted terminal input (workers=1, no retries). Runs on demand via the `demo` suite in `e2e.yml`; not a release gate. The 4K dimension assertion in `demo-reel` is skipped on hosted CI (where the virtual display can't reach 4K) unless `DAINTREE_DEMO_STRICT_DIMS=1` is set.

## Configuration

`playwright.config.ts` at the project root defines the projects. All `full-*` buckets share `coreTimeout` and `retries: isCI ? 2 : 0`. `core` and `online` keep their own timeouts; `nightly` runs at workers=1 with no retries.

`failOnFlakyTests` is a single **top-level** flag (not per-project), wired to `process.env.FAIL_ON_FLAKY_TESTS === "true"`. Only the release-gating runs (`core`, `online`) set that env, so a test that passes on retry fails the run there but is tolerated on PR `full-*` runs for velocity.

| Project         | testDir                 | retries (CI) | workers |
| --------------- | ----------------------- | ------------ | ------- |
| core            | `./e2e/core`            | 2            | 1-2     |
| full-terminal   | `./e2e/full/terminal`   | 2            | 1-2     |
| full-worktree   | `./e2e/full/worktree`   | 2            | 1-2     |
| full-presets    | `./e2e/full/presets`    | 2            | 1-2     |
| full-platform   | `./e2e/full/platform`   | 2            | 1-2     |
| full-panels     | `./e2e/full/panels`     | 2            | 1-2     |
| full-resilience | `./e2e/full/resilience` | 2            | 1-2     |
| full-plugins    | `./e2e/full/plugins`    | 2            | 1-2     |
| online          | `./e2e/online`          | 1            | 1-2     |
| nightly         | `./e2e/nightly`         | 0            | 1       |
| screenshots     | `./e2e/screenshots`     | 0            | 1-2     |
| demo            | `./e2e/demo`            | 0            | 1       |

## Directory Structure

```text
e2e/
├── helpers/
│   ├── selectors.ts     # Centralized SEL constants for all test selectors
│   ├── launch.ts        # launchApp(), mockOpenDialog(), AppContext
│   ├── fixtures.ts      # createFixtureRepo(), createFixtureRepos()
│   ├── project.ts       # openProject(), dismissTelemetryConsent(), openAndOnboardProject()
│   ├── terminal.ts      # getTerminalText(), waitForTerminalText(), runTerminalCommand()
│   └── panels.ts        # getFirstGridPanel(), getGridPanelCount(), getDockPanelCount()
├── core/                # 5 smoke specs (release gate)
│   └── core-*.spec.ts
├── full/
│   ├── terminal/        # PTY mechanics
│   ├── worktree/        # worktree, project, git
│   ├── presets/         # agent presets, recipes
│   ├── platform/        # settings, persistence, a11y, oauth
│   ├── panels/          # browser, dev-preview, portal, review hub
│   ├── resilience/      # errors, IPC, crashes, races, perf
│   └── plugins/         # plugin manager UI, lifecycle, manifest contributions
├── online/              # agent-integration specs (release gate)
│   └── *.spec.ts
├── nightly/             # 2 memory-leak specs (stabilize sweep / on demand)
│   └── nightly-*.spec.ts
├── screenshots/         # marketing screenshot pipeline (on demand)
│   ├── store-reel.spec.ts
│   └── theme-review.spec.ts
└── demo/                # demo-engine specs (on demand)
    ├── demo-reel.spec.ts
    └── demo-terminal-input.spec.ts
```

## Shared Helpers

### Selectors (`e2e/helpers/selectors.ts`)

All test selectors are centralized in the `SEL` object. When a UI element's `aria-label` or `data-testid` changes, update it in one place:

```ts
import { SEL } from "../helpers/selectors";

await window.locator(SEL.toolbar.openSettings).click();
await window.locator(SEL.worktree.card("main")).click();
```

### Launch Helper (`e2e/helpers/launch.ts`)

`launchApp()` creates an isolated temp user-data directory, launches Electron, and waits for the toolbar to be ready. Returns `AppContext { app, window, userDataDir }`.

### Fixtures (`e2e/helpers/fixtures.ts`)

`createFixtureRepo()` creates a temporary git repo with options for multiple files and feature branches. `createFixtureRepos(n)` creates N named repos.

### Project Helper (`e2e/helpers/project.ts`)

`openAndOnboardProject()` combines dialog mocking, folder opening, and onboarding wizard completion. `dismissTelemetryConsent()` clears the first-run telemetry consent prompt when present.

### Terminal Helper (`e2e/helpers/terminal.ts`)

`runTerminalCommand()` clicks the xterm area, types the command, and presses Enter. `waitForTerminalText()` polls via `expect.poll()`.

## Working with xterm.js Terminals

Terminals lease the WebGL renderer (`@xterm/addon-webgl`) when GPU acceleration is available, so the on-screen glyphs aren't reliably present in the DOM. `getTerminalText()` reads through the `__daintreeReadTerminalBuffer` buffer-API bridge first (works with WebGL or the DOM renderer) and only falls back to `.xterm-rows` `innerText` when the buffer reader is unavailable. Prefer `getTerminalText()` / `waitForTerminalText()` over reading `.xterm-rows` directly.

### Reading terminal output

```ts
const panel = getFirstGridPanel(page);
const text = await getTerminalText(panel);
```

### Typing into the HybridInputBar

The HybridInputBar uses CodeMirror 6 (contenteditable div). Use `pressSequentially` with a small delay:

```ts
const cmEditor = agentPanel.locator(".cm-content");
await cmEditor.click();
await cmEditor.pressSequentially("your command here", { delay: 30 });
await window.keyboard.press("Enter");
```

### Gotchas

- **Multiple `.xterm-rows` elements**: Scope locators to the specific panel container.
- **`fill()` doesn't work on CodeMirror**: Use `pressSequentially()` on `.cm-content`.
- **False positive text matching**: The typed command appears in terminal output too.

## Data Test IDs

Components have `data-testid` and `data-worktree-branch` attributes for reliable test targeting. See `e2e/helpers/selectors.ts` for the full list.

## CI Workflows

### `e2e.yml` (unified runner)

A single reusable workflow runs every E2E suite. Pick one via the `suite` input: `full` (meta — all seven buckets sequentially on one runner; workflow_dispatch default), `core`, any of the seven `full-*` buckets (`full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`, `full-plugins`), `online`, `nightly`, or `demo`.

- **Triggers:** workflow_dispatch, workflow_call
- **Matrix:** macOS-14, ubuntu-22.04, windows-latest (selectable via `platform`)
- **Single-file runs:** pass `test_file: e2e/full/<bucket>/foo.spec.ts` and set `suite` to the bucket that owns that path (workflow_dispatch).
- **Conditional behaviour by suite:**
  - `full` — expands to all seven `--project=full-*` flags on a single runner. Use this for ad-hoc validation; the release workflows and `stabilize.yml` fan the buckets out across separate runners instead.
  - `online` — extra `node scripts/ci/install-opencode.mjs`, the single source of truth for the pinned OpenCode CLI version every workflow installs (#11476); bumping it is a deliberate edit to that script. Caller MUST use `secrets: inherit` so `ANTHROPIC_API_KEY` is reachable.
  - `nightly` — Playwright is invoked with `--workers=1` (the memory-leak heuristic depends on serialized launches).
  - All others — no extra steps.

### `e2e-single.yml` (debugging helper)

A separate workflow for fine-grained ad-hoc runs of a single test file with configurable `workers`, `retries`, and an optional `--grep` pattern. Routes through `scripts/ci/run-single-e2e.mjs`, which validates that the spec path matches the chosen project. Use this when iterating on a flaky test in CI.

### `stabilize.yml` (cross-platform validation)

The comprehensive cross-platform surface, dispatched on demand by the `stabilize` skill (`.agents/skills/stabilize/`) — it replaced the old scheduled nightly. `workflow_dispatch` only (no cron), input `platform` defaulting to `linux-windows` (also `windows` | `linux` | `all` | `non-windows` | `macos`). One run executes `check`, unit `test`, `build` + smoke, `integration-test`, `knip`, and every E2E suite (`core`, all seven `full-*` buckets, `online`, and the `nightly` memory-leak soak) across the chosen platforms. It opens no issues — the driving agent triages results from the per-shard `failed-specs-*` / `failure-report-*` artifacts and the `stabilize-merged-playwright-report`. Watch the single `stabilize-ok` gate for the overall verdict. The skill runs the full gate locally first on macOS, so CI defaults to `linux-windows` (no macOS); `windows` alone is the usual iteration target, and `all` (adds macOS-on-CI) is reserved for the rare macOS issue that can't be reproduced locally.

### Release Gating

Releases run as three independent per-OS workflows (`release-macos.yml`, `release-linux.yml`, `release-windows.yml`, #8052), each triggered by the same `v*` tag. Every workflow runs checks, unit tests, and that OS's e2e gates (`core` + the seven `full-*` buckets fanned out as a matrix + `online`) before that OS's platform packaging starts, then publishes that OS's artifacts to R2 the moment its own pipeline is green — a failed or hung OS only delays itself. Because each `full-*` bucket auto-shards inside `e2e.yml` (#8053 — Windows buckets fan out up to 16–32 ways), a full Windows bucket finishes in ~10min wall-time instead of ~39min serial, so Windows `full-*` now gates the Windows release (it no longer takes ~5–6 hours). Pre-release cross-platform confidence beyond what the release tag itself runs comes from `stabilize.yml` (the `stabilize` skill — normally `platform=linux-windows`, since the mandatory local run already covers macOS; `platform=all` only when a macOS-on-CI check is genuinely essential), not from a scheduled nightly — the test-nightly was retired and only `nightly-publish.yml` (binary publish, smoke only) still runs on a cron.

### Cross-Platform Matrix

| Platform | Runner                     | Notes                          |
| -------- | -------------------------- | ------------------------------ |
| macOS    | `macos-14` (Apple Silicon) | No extra setup                 |
| Linux    | `ubuntu-22.04`             | `xvfb-run` for virtual display |
| Windows  | `windows-latest`           | No xvfb needed                 |

### Platform-Specific Electron Flags

`e2e/helpers/launch.ts` adds flags when `CI=true` on Linux:

- `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`

## `test:smoke` vs Playwright `core`

Two distinct smoke checks run at different points in the pipeline:

| Command | What runs | When | Where |
| --- | --- | --- | --- |
| `npm run test:smoke` | `scripts/run-smoke.mjs` — Electron stability soak | Push (Linux only) | `.github/workflows/ci.yml` |
| `npm run test:e2e:core` | Playwright `core` project (5 e2e specs) | Release (all 3 OSes) | `release-{linux,macos,windows}.yml` |

`npm run test:smoke` launches the built Electron binary in `--smoke-test` mode and validates stability markers: node-pty native module load, renderer `did-finish-load`, IPC bridge round-trip, terminal stress rounds, and project persistence stress. It is a single-run soak (with configurable retries) — not a Playwright suite.

`npm run test:e2e:core` runs the 5 Playwright specs in `e2e/core/` against the Electron app. These are deterministic release-gate tests that gate every OS publish.

## Smoke Audit Cadence

The `core` Playwright project is the release-gate smoke — 5 specs that gate every OS publish. To ensure these 5 specs stay calibrated against real regressions, run a quarterly "kill rate" audit:

1. Pull the last 10 release-blocking incidents:
   ```bash
   gh issue list --label "regression" --state closed --limit 10
   ```
   If the `regression` label doesn't exist yet, create it and apply retroactively to known release-blocking regressions. Use `--search "release-blocking in:title"` as a fallback query.
2. For each incident, revert the fix on a local branch.
3. Run `npm run test:e2e:core`.
4. Log every escape where the smoke stays green despite a reverted regression fix as a coverage gap. File a follow-up issue per gap with the `testing` label.
5. Time-box the exercise to one day. If all 10 incidents can't be processed, process the most recent N that fit the box.

If the quarterly cadence proves too heavy for the team, downgrade the trigger to **on every P0 incident** instead — run the audit for each new release-blocking incident as part of postmortem.

The audit is a documentation exercise: no test or workflow code changes are required. The output is a set of follow-up issues identifying gaps in the smoke coverage.
