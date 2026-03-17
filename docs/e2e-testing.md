# E2E Testing

Canopy uses [Playwright](https://playwright.dev/) for end-to-end testing of the Electron app.

## Setup

Playwright is installed as a dev dependency (`@playwright/test`). No browser download is needed — tests launch the real Electron binary directly.

## Running Tests

```bash
npm run test:e2e              # Run all e2e tests (core + online)
npm run test:e2e:core         # Run deterministic core tests only
npm run test:e2e:online       # Run Claude-dependent online tests only
npx playwright test --project=core -g "App Shell"  # Run a specific suite
PWDEBUG=1 npx playwright test --project=core       # Debug mode
```

## Test Suites

Tests are split into two projects:

- **core** — Deterministic tests that don't need network access or API keys. Fast, reliable, run on every push/PR.
- **online** — Tests that interact with Claude Code (requires `ANTHROPIC_API_KEY`). Run nightly and on push to main.

## Configuration

`playwright.config.ts` at the project root defines two projects:

| Property     | Core         | Online         |
| ------------ | ------------ | -------------- |
| testDir      | `./e2e/core` | `./e2e/online` |
| timeout      | 120s         | 300s           |
| retries (CI) | 2            | 1              |
| workers      | 1            | 1              |

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
├── core/
│   ├── core-terminal-panels.spec.ts     # Onboarding, terminal lifecycle, grid/dock, context flow
│   ├── core-shell-settings.spec.ts      # App shell, keyboard shortcuts, settings persistence
│   ├── core-advanced.spec.ts            # Browser, sidecar, notes, worktree lifecycle, project switch
│   └── core-v030-features.spec.ts       # Sidebar search, settings subtabs/search, review hub, layout
└── online/
    └── claude-online.spec.ts            # Full Claude agent interaction flow
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

### `e2e-core.yml`

- **Triggers:** push to main/develop, PRs, workflow_dispatch, workflow_call
- **Matrix:** macOS-14, ubuntu-22.04, windows-latest
- **No secrets needed**

### `e2e-online.yml`

- **Triggers:** nightly (3am UTC), push to main, workflow_dispatch, workflow_call
- **Requires:** `ANTHROPIC_API_KEY` secret
- **Nightly failure notification:** Creates/updates a GitHub issue labeled `e2e-nightly-failure`

### Release Gating

Both `e2e-core` and `e2e-online` must pass before `release.yml` publishes artifacts.

### Cross-Platform Matrix

| Platform | Runner                     | Notes                          |
| -------- | -------------------------- | ------------------------------ |
| macOS    | `macos-14` (Apple Silicon) | No extra setup                 |
| Linux    | `ubuntu-22.04`             | `xvfb-run` for virtual display |
| Windows  | `windows-latest`           | No xvfb needed                 |

### Platform-Specific Electron Flags

`e2e/helpers/launch.ts` adds flags when `CI=true` on Linux:

- `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`
