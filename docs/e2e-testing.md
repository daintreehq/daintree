# E2E Testing

Daintree uses [Playwright](https://playwright.dev/) for end-to-end testing of the Electron app.

## Setup

Playwright is installed as a dev dependency (`@playwright/test`). No browser download is needed — tests launch the real Electron binary directly.

## Running Tests

```bash
npm run test:e2e                   # Run every Playwright project
npm run test:e2e:core              # Lightweight release-gating smoke
npm run test:e2e:full              # Run all six full-* buckets
npm run test:e2e:full-terminal     # Run a single bucket — substitute any of:
                                   #   full-terminal full-worktree full-presets
                                   #   full-platform full-panels full-resilience
npm run test:e2e:online            # Claude/OpenCode-dependent online tests
npm run test:e2e:nightly           # Soak / memory-leak nightly tests
npx playwright test e2e/full/terminal/core-terminal-search.spec.ts  # Single file
PWDEBUG=1 npx playwright test --project=core                         # Debug mode
```

## Test Suites

Tests are split into nine Playwright projects:

- **core** — Lightweight deterministic release-gate smoke (5 specs). This is the Playwright e2e smoke suite (`npm run test:e2e:core`), distinct from the Electron stability soak (`npm run test:smoke`). See [test:smoke vs Playwright core](#testsmoke-vs-playwright-core) below.
- **full-terminal** — PTY mechanics, scrollback, search, layout, recipes, output flood, context injection, fleet broadcast.
- **full-worktree** — Worktree lifecycle, project switching, git detection, cross-project flows.
- **full-presets** — Agent presets, recipes, onboarding, CCR.
- **full-platform** — Settings, persistence, a11y, keyboard, OS-shell surfaces, oauth, security.
- **full-panels** — Browser, dev-preview, portal, review hub, file viewer, drag-drop, action palette, toolbar chrome.
- **full-resilience** — Errors, IPC, crashes, races, perf budgets, diagnostics.
- **online** — Tests that interact with real agent CLIs (requires `ANTHROPIC_API_KEY`).
- **nightly** — Long-running memory-leak detection (workers=1, no retries).

## Configuration

`playwright.config.ts` at the project root defines the projects. All `full-*` buckets share `coreTimeout` and `retries: 2 (CI)`. `core` and `online` keep their own timeouts; `nightly` runs at workers=1 with no retries.

| Project         | testDir                 | retries (CI) | failOnFlakyTests | workers |
| --------------- | ----------------------- | ------------ | ---------------- | ------- |
| core            | `./e2e/core`            | 2            | true             | 1-2     |
| full-terminal   | `./e2e/full/terminal`   | 2            | false            | 1-2     |
| full-worktree   | `./e2e/full/worktree`   | 2            | false            | 1-2     |
| full-presets    | `./e2e/full/presets`    | 2            | false            | 1-2     |
| full-platform   | `./e2e/full/platform`   | 2            | false            | 1-2     |
| full-panels     | `./e2e/full/panels`     | 2            | false            | 1-2     |
| full-resilience | `./e2e/full/resilience` | 2            | false            | 1-2     |
| online          | `./e2e/online`          | 2            | true             | 1-2     |
| nightly         | `./e2e/nightly`         | 0            | false            | 1       |
| screenshots     | `./e2e/screenshots`     | 0            | false            | 1-2     |

## Directory Structure

```text
e2e/
├── helpers/
│   ├── selectors.ts     # Centralized SEL constants for all test selectors
│   ├── launch.ts        # launchApp(), mockOpenDialog(), AppContext
│   ├── fixtures.ts      # createFixtureRepo(), createFixtureRepos()
│   ├── project.ts       # openProject(), completeOnboarding(), openAndOnboardProject()
│   ├── terminal.ts      # getTerminalText(), waitForTerminalText(), runTerminalCommand()
│   └── panels.ts        # getFirstGridPanel(), getGridPanelCount(), getDockPanelCount()
├── core/                # 5 smoke specs (release gate)
│   └── core-*.spec.ts
├── full/
│   ├── terminal/        # 15 specs — PTY mechanics
│   ├── worktree/        # 11 specs — worktree, project, git
│   ├── presets/         # 17 specs — agent presets, recipes
│   ├── platform/        # 17 specs — settings, persistence, a11y, oauth
│   ├── panels/          # 16 specs — browser, dev-preview, portal, review hub
│   └── resilience/      # 18 specs — errors, IPC, crashes, races, perf
├── online/              # 3 agent-integration specs (release gate)
│   └── *-online.spec.ts
└── nightly/             # 2 memory-leak specs (nightly only)
    └── nightly-*.spec.ts
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

`openAndOnboardProject()` combines dialog mocking, folder opening, and onboarding wizard completion.

### Terminal Helper (`e2e/helpers/terminal.ts`)

`runTerminalCommand()` clicks the xterm area, types the command, and presses Enter. `waitForTerminalText()` polls via `expect.poll()`.

## Working with xterm.js Terminals

xterm.js v6 uses the **DOM renderer** by default. Terminal output is rendered in `.xterm-rows`, making it readable via Playwright locators.

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

A single reusable workflow runs every E2E suite. Pick one via the `suite` input: `full` (meta — all six buckets sequentially on one runner; workflow_dispatch default), `core`, any of the six `full-*` buckets (`full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`), `online`, or `nightly`.

- **Triggers:** workflow_dispatch, workflow_call
- **Matrix:** macOS-14, ubuntu-22.04, windows-latest (selectable via `platform`)
- **Single-file runs:** pass `test_file: e2e/full/<bucket>/foo.spec.ts` and set `suite` to the bucket that owns that path (workflow_dispatch).
- **Conditional behaviour by suite:**
  - `full` — expands to six `--project=full-*` flags on a single runner. Use this for ad-hoc validation; release and nightly fan the buckets out across separate runners instead.
  - `online` — extra `npm install -g opencode-ai`. Caller MUST use `secrets: inherit` so `ANTHROPIC_API_KEY` is reachable.
  - `nightly` — Playwright is invoked with `--workers=1` (the memory-leak heuristic depends on serialized launches).
  - All others — no extra steps.

### `e2e-single.yml` (debugging helper)

A separate workflow for fine-grained ad-hoc runs of a single test file with configurable `workers`, `retries`, and an optional `--grep` pattern. Routes through `scripts/ci/run-single-e2e.mjs`, which validates that the spec path matches the chosen project. Use this when iterating on a flaky test in CI.

### Release Gating

Releases run as three independent per-OS workflows (`release-macos.yml`, `release-linux.yml`, `release-windows.yml`, #8052), each triggered by the same `v*` tag. Every workflow runs checks, unit tests, and that OS's e2e gates (`core` + the six `full-*` buckets fanned out as a matrix + `online`) before that OS's platform packaging starts, then publishes that OS's artifacts to R2 the moment its own pipeline is green — a failed or hung OS only delays itself. Because each `full-*` bucket auto-shards 4 ways inside `e2e.yml` (#8053), a full Windows bucket finishes in ~10min wall-time instead of ~39min serial, so Windows `full-*` now gates the Windows release (it no longer takes ~5–6 hours). Nightly is unchanged: it runs `core` and `online` across all three OSes; the `full-*` buckets and the memory-leak `nightly` project run on macOS and Linux only (still serially across OSes, but each `full-*` bucket is auto-sharded there too).

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
