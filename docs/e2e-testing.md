# E2E Testing

Canopy uses [Playwright](https://playwright.dev/) for end-to-end testing of the Electron app.

## Setup

Playwright is installed as a dev dependency (`@playwright/test`). No browser download is needed — tests launch the real Electron binary directly.

## Running Tests

```bash
npm run test:e2e                           # Run all e2e tests
npx playwright test e2e/smoke.spec.ts      # Run a specific test file
npx playwright test -g "settings dialog"   # Run a specific test by name
PWDEBUG=1 npx playwright test              # Debug mode — step through with Inspector UI
```

## Configuration

`playwright.config.ts` at the project root:

- **testDir:** `./e2e`
- **workers:** 1 (serial execution — Electron tests share system resources)
- **fullyParallel:** false
- **retries:** 2 on CI, 0 locally
- **timeout:** 180s per test (agent interactions can be slow)
- **trace:** captured on first retry
- **screenshots:** captured on failure
- **outputDir:** `./test-results` (gitignored)

## Test Structure

```text
e2e/
├── launch.ts              # Shared app launch + dialog mocking helpers
├── fixtures.ts            # Temp git repo creation for tests
├── smoke.spec.ts          # Basic launch and core UI checks
├── full-flow.spec.ts      # End-to-end: open project → launch agent → send command → verify output
├── project-setup.spec.ts  # Open folder, onboarding wizard flow
├── settings.spec.ts       # Settings dialog open/close and tab navigation
└── toolbar.spec.ts        # Toolbar buttons, sidebar toggle, problems badge
```

### Launch Helper (`e2e/launch.ts`)

All test files share a `launchApp()` helper that creates an isolated temp user-data directory, launches Electron, and waits for the toolbar to be ready. Tests use `beforeAll` / `afterAll` to launch once per file.

```ts
import { launchApp, type AppContext } from "./launch";

let ctx: AppContext;
test.beforeAll(async () => {
  ctx = await launchApp();
});
test.afterAll(async () => {
  await ctx?.app.close();
});
```

### Mocking Native Dialogs

Electron's native file dialogs (`dialog.showOpenDialog`) can't be controlled through the DOM. Instead, mock them via `app.evaluate()` on the main process before triggering the UI action:

```ts
import { mockOpenDialog } from "./launch";

await mockOpenDialog(app, "/path/to/project");
await window.getByRole("button", { name: "Open Folder" }).click();
```

### Fixture Repos (`e2e/fixtures.ts`)

Tests that need a project use `createFixtureRepo()` to create a temporary git repo with an initial commit. These are created dynamically (no checked-in fixtures) so they work identically on CI and locally.

```ts
import { createFixtureRepo } from "./fixtures";
const repoPath = createFixtureRepo("my-test-project");
```

## Working with xterm.js Terminals

xterm.js v6 uses the **DOM renderer** by default (Canopy does not load the canvas/WebGL addon). This means terminal output is rendered as real DOM text nodes in `.xterm-rows`, making it readable via Playwright locators.

### Reading terminal output

Scope to a specific panel to avoid ambiguity (there may be multiple `.xterm-rows` — one in the grid panel, another in the dock):

```ts
const agentPanel = window.locator('[aria-label^="Claude agent:"]');
const text = await agentPanel.locator(".xterm-rows").innerText();
```

### Polling for specific output

Use `expect.poll()` to wait for text to appear:

```ts
await expect
  .poll(() => agentPanel.locator(".xterm-rows").innerText(), {
    timeout: 60_000,
    intervals: [500],
  })
  .toContain("expected text");
```

### Typing into the HybridInputBar

The HybridInputBar uses CodeMirror 6 (contenteditable div). Use `pressSequentially` with a small delay, not `fill()` or `keyboard.type()`:

```ts
const cmEditor = agentPanel.locator(".cm-content");
await cmEditor.click();
await cmEditor.pressSequentially("your command here", { delay: 30 });
await window.keyboard.press("Enter");
```

**Sending a raw keystroke** (e.g. pressing Enter to confirm a CLI prompt like "trust this folder"):

```ts
const cmEditor = agentPanel.locator(".cm-content");
await cmEditor.click();
await window.keyboard.press("Enter"); // empty input + Enter = raw keystroke to PTY
```

### Waiting for agent readiness

After launching an agent, wait for its TUI to fully load before sending commands. Check for known text in the terminal output:

```ts
// Wait for Claude's welcome screen
await expect
  .poll(() => agentPanel.locator(".xterm-rows").innerText(), { timeout: 60_000, intervals: [500] })
  .toContain("Welcome");
```

### Gotchas

- **Multiple `.xterm-rows` elements**: The dock and the grid panel each have their own xterm instance. Always scope locators to the specific panel container.
- **`fill()` doesn't work on CodeMirror**: Use `pressSequentially()` on the `.cm-content` locator instead.
- **False positive text matching**: The command you type appears in the terminal output too. After sending a command, wait a fixed duration (e.g. `waitForTimeout(15_000)`) before checking the response, or look for text that's distinct from the input.
- **`aria-busy` on the input bar**: The HybridInputBar has `aria-busy="true"` while the agent is initializing. Wait for `aria-busy="false"` before interacting, but note this alone doesn't mean the agent's TUI has fully loaded.

## Key Patterns

- **Isolated user data:** Each launch creates a temp directory via `mkdtempSync` to avoid polluting real app state.
- **Main process evaluation:** Use `app.evaluate(({ app }) => ...)` to call Electron main-process APIs.
- **Prefer `aria-label` selectors:** These are stable across style changes. Example: `[aria-label="Open settings"]`.
- **Screenshots:** Save to `test-results/` for CI artifact collection.
- **Debugging:** Add `await window.pause()` anywhere in a test to freeze at that point and inspect the DOM.

## CI

- Retries are set to 2 on CI (`process.env.CI`).
- Traces and failure screenshots are written to `test-results/` for upload as CI artifacts.
- `playwright-report/` and `test-results/` are both gitignored.
