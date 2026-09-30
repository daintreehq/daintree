# E2E Testing

Daintree uses [Playwright](https://playwright.dev/) for end-to-end testing of the Electron app.

## Setup

Playwright is installed as a dev dependency (`@playwright/test`). No browser download is needed — tests launch the real Electron binary directly.

Specs run against the built app, so run `npm run build:e2e` first and again after any `src/`, `electron/` or `shared/` change; a stale or failed build silently tests the old bundle. Spec edits under `e2e/` are live without a rebuild. `e2e/` is typechecked as part of `npm run typecheck` (`tsconfig.e2e.json`, which also covers every `playwright*.config.ts`).

## Running Tests

```bash
npm run test:e2e                   # Every project in playwright.config.ts
npm run test:e2e:core              # Lightweight release-gating smoke
npm run test:e2e:full              # Run all seven full-* buckets
npm run test:e2e:full-terminal     # Run a single bucket — substitute any of:
                                   #   full-terminal full-worktree full-presets
                                   #   full-platform full-panels full-resilience
                                   #   full-plugins
npm run test:e2e:online            # Claude/OpenCode-dependent online tests
npm run test:e2e:nightly           # Memory-leak / soak suite (serialized, workers=1)
npm run test:e2e:screenshots       # Design-review captures (each spec self-skips without its env var)
npm run test:e2e:demo              # Demo-engine specs (own config, workers=1, screencast capture)
npm run perf list                  # Every benchmark; run one with `npm run perf <command>`
npx playwright test e2e/full/terminal/core-terminal-pane.spec.ts   # Single file
PWDEBUG=1 npx playwright test --project=core                       # Debug mode
DAINTREE_E2E_KEEP_USERDATA=1 npx playwright test --project=core    # Keep temp userData/HOME dirs
```

Demo, perf, mechanism, live-plugin and assistant specs each have their own config (below), so a bare `npm run test:e2e` never reaches them.

### Background windows

Local macOS runs are invisible by default. Every app window is mapped but transparent and click-through, the app can never be activated (so it has no Dock or Cmd-Tab presence and never takes the menu bar), and it never takes OS focus, so a suite can run while you keep working. Focus is virtual inside the app: the calls that focus a window headed (`show()`, `focus()`, `restore()`, `webContents.focus()`) record it as focused, the ones that take focus away (`blur()`, `hide()`, `minimize()`, close) hand it to another visible window, and `isFocused()`/`getFocusedWindow()` read that record, so focus-gated main-process paths behave as they do headed. The main-process side lives in `electron/setup/e2eBackgroundWindows.ts`, behind `--daintree-e2e-background-windows`.

The first match decides whether a launch is headed: CI or a non-macOS platform (always headed — Linux ignores window opacity, and Windows lets an invisible window take keyboard focus); an explicit `launchApp({ headed })`; `DAINTREE_E2E_HEADED=1` or any `PWDEBUG`; Playwright's `--headed`/`--debug`. Otherwise the launch runs in the background. A spec a human has to watch, or one that measures on-screen behaviour, passes `headed: true`, as the interactive theme tour and `scripts/perf/foreground-terminal.ts` do.

```bash
npx playwright test --project=core --headed                          # Watch the run
```

## Test Suites

Tests are split into eleven Playwright projects:

- **core** — Lightweight deterministic release-gate smoke (3 specs: the restart-persistence journey, agent promotion in a terminal, and the worktree lifecycle). This is the Playwright e2e smoke suite (`npm run test:e2e:core`), distinct from the Electron stability soak (`npm run test:smoke`). See [test:smoke vs Playwright core](#testsmoke-vs-playwright-core) below.
- **full-terminal** — Typed terminal I/O (copy, paste, search, links, context menu), PTY mechanics, scrollback, layout, recipes, output flood, context injection, fleet broadcast, and the MCP terminal-notice and orchestration journey.
- **full-worktree** — Worktree lifecycle, project switching, git detection, cross-project flows, agent and scrollback restore across relaunch.
- **full-presets** — Agent presets, recipes, CCR, and what a preset launch actually hands the agent.
- **full-platform** — Settings, persistence, a11y, keyboard, OS-shell surfaces, oauth, security.
- **full-panels** — Browser, dev-preview, portal, Review Hub, file viewer and editor, drag-drop, action palette, notifications, toolbar chrome.
- **full-resilience** — Errors, IPC faults, real pty-host and renderer crashes, races, process cleanup, diagnostics, MCP consent and workspace binding.
- **full-plugins** — Plugin manager UI, plugin lifecycle (enable/disable, restart gating), manifest contribution rendering against the sideloaded sample plugin, and `launchMcp` for every wired agent.
- **online** — Tests that interact with real agent CLIs (requires `ANTHROPIC_API_KEY`).
- **nightly** — Long-running memory-leak / soak detection, 4 specs (workers=1, no retries). The project name predates the scheduled nightly; it now runs as part of the `stabilize` sweep and on demand, not on a cron.
- **screenshots** — The theme tour and the per-surface design-review captures. Run locally on demand, not part of the PR/release gates.

## Writing Tests

An E2E test costs a cold Electron launch, so it has to earn it. Anything a unit test can prove belongs in vitest; an E2E spec exists to prove something only the assembled app can.

- **Cross a process or OS seam.** Renderer to main, main to pty-host, the app to git, the filesystem, a child process or an HTTP client. A test that stays inside one store is a unit test in the wrong place.
- **Assert user-visible or OS truth.** Rendered text, PTY output, git state on disk, file contents, pids, HTTP replies. Store and IPC values are diagnostics for the failure message, never the subject of the assertion.
- **Backdoors are for setup and fault injection only.** `dispatchAction`, seeding, `runTerminalCommand` and the fault registry set the scene; the gesture under test goes through the real entry point — a click, a keybinding, typed keys, the palette, a real MCP client.
- **Deterministic by construction.** Fake agent CLIs (`e2e/helpers/fakeAgent.ts`) instead of real ones, local bare remotes instead of a forge, and no network outside `online`. Poll with `expect.poll` or web-first assertions; never sleep. A negative assertion ("no dialog appeared") needs a dwell window long enough for the positive case to have happened.
- **Fail loud.** No runtime `test.skip()` because a feature "wasn't reachable" — that is a failure. Platform skips and quarantines carry a structured annotation (`{ type: "platform-skip" | "conditional-skip" | "quarantine", description }`, a quarantine's description starting `YYYY-MM-DD`), enforced by the `structured-test-skip-annotations` ESLint rule. `core-file-edit.spec.ts`, the restored-scrollback check in `startup-agent-worktree-restore.spec.ts` and the reload notice in `core-pty-host-crash.spec.ts` are the current quarantines.
- **One launch per file.** Each file is a launch group: one `launchApp` in `beforeAll`, tests that share it, one `closeApp` in `afterAll`. Use Playwright's default mode unless the file is a true journey where each step builds on the last (`test.describe.serial`). Extra launches are for restart journeys or a deliberately different launch configuration. There is no app fixture shared across files.
- **Delete what can't earn its launch.** A test that cannot fail, that asserts internals a unit test already covers, or whose feature is gone gets deleted, not kept green.

### Waits

`waitForTimeout` is legal only to span a named product timer, with a `// timer: <NAME>` comment on the line above naming that timer. `isVisible({ timeout })` is never a wait — Playwright ignores the timeout and returns immediately; use `expect(locator).toBeVisible()` or a poll. `scripts/ci/check-e2e-waits.mjs` ratchets both per file against `scripts/baselines/e2e-waits-baseline.json`; it runs as `npm run e2e-waits:check` inside `npm run check`, and `npm run e2e-waits:update` rewrites the baseline after a reduction. The opt-in trees (`assistant`, `demo`, `mechanism`, `perf`, `plugins`, `screenshots`) are outside it.

Where a product timer is too long to sit through, an unpackaged E2E launch can shorten it instead: `DAINTREE_E2E_SHELL_COMMAND_EXPIRY_MS` (shell-command expiry) and `DAINTREE_E2E_TRASH_TTL_MS` (trashed-panel TTL) are read only when `DAINTREE_E2E_MODE=1` and the app is unpackaged, and are validated in `shared/config/e2eTimerOverrides.ts`. Add a new override the same way rather than sleeping.

### Launch groups and run time

Current launch call sites (`launchApp` / `launchWithSamplePlugin`) per gated bucket; files with more than one are restart journeys or need a second configuration:

| Project         | Spec files | Launch call sites |
| --------------- | ---------- | ----------------- |
| core            | 3          | 5                 |
| full-terminal   | 11         | 12                |
| full-worktree   | 14         | 18                |
| full-presets    | 5          | 7                 |
| full-platform   | 12         | 16                |
| full-panels     | 21         | 24                |
| full-resilience | 19         | 27                |
| full-plugins    | 4          | 4                 |
| online          | 3          | 4                 |
| nightly         | 4          | 6                 |

A local macOS run of the gated suite (core plus the seven `full-*` buckets, workers=1) takes about 32 minutes. `npm run e2e-durations -- <report.json>...` (`scripts/ci/e2e-durations.mjs`) turns Playwright JSON reports (`PLAYWRIGHT_JSON_REPORT=1` or `PLAYWRIGHT_JSON_OUTPUT_FILE`) into per-spec and per-project durations, merging shards or platforms; launch time in `beforeAll` is attributed to no test, so its figures are lower bounds.

Scenario specs worth reading before writing a new one: `core-restart-persistence` (a journey across three real relaunches), `core-pty-host-crash` (SIGKILLs the real pty-host by pid and crashes the project renderer), `mcp-consent-tiers` (a real Streamable HTTP client, consent dialogs, outcomes read from git), `core-launch-mcp` (every wired agent's launch, checked on the command line, on disk and over HTTP), `mcp-terminal-notify` (an agent pane orchestrating its own workers over MCP), `core-terminal-pane` (typed terminal I/O), `core-review-hub-workflow` (every commit and push checked against git on disk), `preset-launch-outcome` (what the agent was actually launched with), `core-diff-panel` (worktree card to rendered hunks, image diff, stale refresh and a review note delivered as bracketed-paste bytes), `core-codex-agent` (a non-Claude agent detected, driven and resumed through the registry) and `core-file-edit` (edit, save, close guard and disk conflict; quarantined while the built Markdown editor fails to load).

## Configuration

`playwright.config.ts` at the project root defines the eleven projects. All `full-*` buckets share `coreTimeout` and `retries: isCI ? 2 : 0`; `full-plugins` and `online` are pinned to workers=1 in the project itself. `core` and `online` keep their own timeouts; `nightly` runs at workers=1 with no retries. Local macOS runs use one worker for every project (parallel cold launches contend for crashpad Mach ports), and retries are 0 locally, so a local pass is a real pass.

Every config shares `e2e/global-setup.ts` and `e2e/global-teardown.ts`. Setup reaps `daintree-e2e-*` temp dirs older than 24 hours that a killed run left behind and opens a manifest for this run; every userData and HOME dir a launch creates is recorded there, and teardown removes them all (not `closeApp`, because restart journeys relaunch on the same userData). `DAINTREE_E2E_KEEP_USERDATA=1` keeps them for a post-mortem and prints the manifest path.

`failOnFlakyTests` is a single **top-level** flag (not per-project), wired to `process.env.FAIL_ON_FLAKY_TESTS === "true"`. Only the release-gating runs (`core`, `online`) set that env, so a test that passes on retry fails the run there but is tolerated on PR `full-*` runs for velocity.

### Mechanism checks (separate config)

`playwright.mechanism.config.ts` holds checks that answer "does the platform actually behave this way" rather than "does the product still work" — currently `e2e/mechanism/media-range-streaming.spec.ts`, which is intended to establish whether Chromium issues real follow-up byte ranges against the `standard: true` `daintree-media://` scheme (#12242). Run it with `npm run test:e2e:mechanism`, after `npm run build:e2e`.

It is a second config rather than a twelfth project on purpose: `npm run test:e2e` is a bare `npx playwright test`, which runs _every_ project in `playwright.config.ts`, and these generate several hundred megabytes of encoded fixtures per run. Don't fold it in.

### Assistant workflow runs (separate config)

`playwright.assistant.config.ts` drives the Daintree Assistant (Codex or Claude Code) through real workflows against the installed agent CLIs on your own subscriptions: a seeded project, the user's messages typed into the assistant pane, and a check against what the run left behind. Opt-in and local only, never in a suite, a release gate or `npm run test:e2e`, for the same reason as the configs above; nothing runs unless `DAINTREE_E2E_ASSISTANT_WORKFLOW` names scenarios.

```bash
npm run build:e2e
DAINTREE_E2E_ASSISTANT_WORKFLOW=facts-vote DAINTREE_E2E_AUTO_TRUST=1 npm run test:e2e:assistant                                   # Codex assistant
DAINTREE_E2E_ASSISTANT_WORKFLOW=facts-vote DAINTREE_E2E_AUTO_TRUST=1 DAINTREE_E2E_ASSISTANT_AGENT=claude npm run test:e2e:assistant  # Claude Code assistant
```

`DAINTREE_E2E_AUTO_TRUST=1` answers worker trust dialogs as a user whose project every CLI already trusts (a CLI may remember that answer for the temporary project path in its own config); leave it off to exercise the assistant's own dialog handling. An unknown scenario id fails the run instead of skipping everything, and so does a turn that never settles within the scenario's budget or a run whose assistant transcript cannot be found. Each run writes a timeline, screenshots, every terminal's final text, the assistant's instructions and transcript, copies of its session files and `metrics.json` (turns, notices, tool calls, tokens, and every reply a `waitForReply` returned with its outcome and handback summary, or `unread` when a result could not be parsed) under `test-results-assistant/`, which the next run clears.

A new workflow is one entry in `e2e/assistant/scenarios.ts`: an `id`, the project files (`e2e/assistant/projects.ts` has a small inventory CLI), the messages, a timeout and a `check`. Checks match text against `answer` (what the assistant said, from its transcript) rather than the screen, which also shows the user's prompt. Each turn waits until every agent is idle, so notices land inside it; `settleOnAssistant` sends the next message as soon as the assistant is idle instead. The kit is `e2e/assistant/harness.ts`.

### Demo-engine specs (separate config)

`playwright.demo.config.ts` runs `e2e/demo/`, the specs that exercise the in-app demo automation API (`window.electron.demo`): screencast recording and scripted terminal input (workers=1, no retries). It shares the main config's reporter wiring, so the `demo` suite in `e2e.yml` produces the same JSON and blob outputs; it runs on demand and is not a release gate. It is a separate config so a bare `npm run test:e2e` never records 4K screencasts.

```bash
npm run build:e2e && npm run test:e2e:demo
npm run build:e2e && npx playwright test --config=playwright.demo.config.ts e2e/demo/demo-terminal-input.spec.ts
```

- **`demo-terminal-input.spec.ts`** proves `typeInTerminal` and `sendKeyToTerminal` reach a real PTY.
- **`demo-reel.spec.ts`** records the worktree-dashboard reel and checks the capture pipeline. Its 4K dimension assertion is skipped on hosted CI (where the virtual display can't reach 4K) unless `DAINTREE_DEMO_STRICT_DIMS=1` is set.
- **`intro-video.spec.ts`** records the narrated intro video. It has no assertions and drives the real Claude, Codex, Grok and Antigravity CLIs by default, so it skips unless `DAINTREE_DEMO_INTRO=1`.

### Performance harnesses (separate config)

Benchmarks live in `e2e/perf/` and run through `playwright.perf.config.ts` (one `perf` project, workers=1, no retries — a retry would hide the variance a benchmark exists to report). None of them rides along with a correctness bucket. Drive them through the perf CLI, which rebuilds when the benchmark needs it and sets the spec's opt-in gate:

```bash
npm run perf list          # every benchmark and what it measures
npm run perf list-mount    # one benchmark by command name
npm run test:e2e:perf      # the raw Playwright config, gates unset
```

Every spec under `e2e/perf/` must have an entry in `scripts/perf/registry.ts`; `scripts/perf/__tests__/perfRegistry.test.ts` fails on one that doesn't. A correctness check that used to carry a budget stays in its bucket and asserts behaviour only (`core-perf-list-mount-budget.spec.ts` checks virtualization; its DOM and long-frame budgets are the `list-mount` benchmark).

### Live plugin checks (separate config)

`playwright.plugins.config.ts` drives a plugin through the real app against the real toolchain it targets, on request only — never in a suite, a release gate or `npm run test:e2e`, for the same reason as the mechanism checks. One spec per plugin under `e2e/plugins/`:

```bash
npm run build:e2e && npm run test:e2e:plugins                                                         # every plugin
npm run build:e2e && npx playwright test --config=playwright.plugins.config.ts e2e/plugins/sveltekit-builder.spec.ts
```

- **`sveltekit-builder.spec.ts`** creates a throwaway SvelteKit 2 + Svelte 5 + Tailwind 4 app and installs its dependencies from the registry (network on a cold npm cache), runs it in a dev preview, and walks SvelteKit Tools: enable, switch it on with its command so it opens a dev preview and starts the site, close it and switch it back on from the preview's own toolbar button, click an element in the preview, walk up to the component that drew it with Option+Up, then send the component to an agent terminal and wait for the site to change. The agent is a deterministic fake `claude` (`e2e/plugins/helpers/siteAgent.ts`) that applies the requested edit only at the source location the prompt names, so a pass proves the context SvelteKit Tools sent.

Things these specs have to handle that bucket specs don't:

- **Plugin commands can confirm.** A plugin whose manifest holds a high-risk capability (any `fs:*-write`, for one) gets a "Run '…'?" dialog on every command unless the command declares the capabilities it actually uses with `requires` — `[]` for one that only opens a panel. The dispatch stays pending until the dialog is answered.
- **Built-ins are default-off.** Enable with `window.electron.plugin.setEnabled(id, true)` and poll `getPanelKinds()` / `getActions()`.
- **The preview's page is only reachable from main.** The host renderer's Trusted Types policy rejects `webview.executeJavaScript`; use `app.evaluate` over `webContents.getAllWebContents()` filtered to `getType() === "webview"`. Click at the element's real position: the webview's bounding box plus the element's client rect.
- **A fixture project's `package.json` type applies to scripts in it.** An extensionless fake CLI inside a `"type": "module"` project loads as ESM, so `require` throws; use `process.getBuiltinModule`.
- **Print diagnostics on failure.** A blank panel or a silent preview has no assertion message worth reading; the SvelteKit Tools spec dumps the builder's text, the renderer console, the preview's console (collected from `web-contents-created`) and what the agent received.

| Project         | testDir                 | retries (CI) | workers |
| --------------- | ----------------------- | ------------ | ------- |
| core            | `./e2e/core`            | 2            | 1-2     |
| full-terminal   | `./e2e/full/terminal`   | 2            | 1-2     |
| full-worktree   | `./e2e/full/worktree`   | 2            | 1-2     |
| full-presets    | `./e2e/full/presets`    | 2            | 1-2     |
| full-platform   | `./e2e/full/platform`   | 2            | 1-2     |
| full-panels     | `./e2e/full/panels`     | 2            | 1-2     |
| full-resilience | `./e2e/full/resilience` | 2            | 1-2     |
| full-plugins    | `./e2e/full/plugins`    | 2            | 1       |
| online          | `./e2e/online`          | 1            | 1       |
| nightly         | `./e2e/nightly`         | 0            | 1       |
| screenshots     | `./e2e/screenshots`     | 0            | 1-2     |

## Directory Structure

```text
e2e/
├── global-setup.ts      # stale temp-dir reaper, per-run temp manifest
├── global-teardown.ts   # removes every temp dir the run recorded
├── helpers/
│   ├── selectors.ts     # Centralized SEL constants for all test selectors
│   ├── launch.ts        # launchApp(), closeApp(), mockOpenDialog(), AppContext
│   ├── tempDirs.ts      # temp-dir manifest and reaping
│   ├── actions.ts       # dispatchAction() — setup backdoor
│   ├── fixtures.ts      # createFixtureRepo(), createFixtureRepos()
│   ├── project.ts       # openProject(), openAndOnboardProject()
│   ├── terminal.ts      # typeTerminalCommand(), runTerminalCommand(), getTerminalText(), getTerminalViewport()
│   ├── fakeAgent.ts     # installFakeAgent() and its log readers
│   ├── ipcFaults.ts     # main-process fault injection
│   ├── panels.ts        # getFirstGridPanel(), getGridPanelCount(), getDockPanelCount()
│   └── …                # plugins, presets, notifications, theme, stress, timeouts, …
├── core/                # 3 smoke specs (release gate)
├── full/
│   ├── terminal/        # typed terminal I/O, PTY mechanics, MCP notices
│   ├── worktree/        # worktree, project, git, restore
│   ├── presets/         # agent presets, recipes, launch outcome
│   ├── platform/        # settings, persistence, a11y, oauth
│   ├── panels/          # browser, dev-preview, portal, Review Hub, files
│   ├── resilience/      # errors, IPC faults, crashes, races, MCP consent
│   └── plugins/         # plugin manager UI, lifecycle, manifest contributions, launchMcp
├── online/              # agent-integration specs (release gate)
├── nightly/             # 4 memory-leak / soak specs (stabilize sweep / on demand)
├── screenshots/         # design-review capture harnesses (on demand)
│   ├── theme-tour.spec.ts        # 19-scene theme review tour
│   └── *-review.spec.ts          # per-surface design-review captures
├── demo/                # demo-engine specs (playwright.demo.config.ts)
│   └── intro/                    # intro-video scenes, fixtures and post-processing
├── perf/                # benchmarks (playwright.perf.config.ts, npm run perf)
├── mechanism/           # platform-behaviour checks (playwright.mechanism.config.ts)
├── plugins/             # live plugin checks (playwright.plugins.config.ts)
└── assistant/           # assistant workflow runs (playwright.assistant.config.ts)
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

`launchApp()` creates a temp user-data directory, launches Electron, and waits for the toolbar to be ready. Returns `AppContext { app, window, userDataDir, homeDir }`. Pass `userDataDir` to relaunch onto an earlier session; a relaunch gets back the same HOME.

Every launch runs with a throwaway HOME by default (`isolateHome: true`): `HOME`, `USERPROFILE`, `APPDATA`/`LOCALAPPDATA`, the XDG dirs, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `ZDOTDIR` all point into it, so nothing a spec does reaches the real `~/.daintree`, agent configs or shell profile. It is seeded with quiet shell rc files, a git identity with signing off, and an empty `.claude.json` so Claude reads as signed in. Read anything home-relative from `ctx.homeDir`, never `os.homedir()`. `homeDir` hands in a HOME the spec prepared; `isolateHome: false` opts out, only for specs that drive real agent CLIs on the user's own login.

### Fixtures (`e2e/helpers/fixtures.ts`)

`createFixtureRepo()` creates a temporary git repo with options for multiple files and feature branches. `createFixtureRepos(n)` creates N named repos.

### Project Helper (`e2e/helpers/project.ts`)

`openAndOnboardProject()` mocks the folder dialog, opens the project, waits for its view to become active and clears any blocking palette.

### Terminal Helper (`e2e/helpers/terminal.ts`)

`typeTerminalCommand(page, panelId, cmd, { delayMs, submit, expectOutput, timeout })` proves the pane's xterm input holds focus and types real keystrokes, so the bytes travel keyboard → xterm `onData` → PTY; use it whenever terminal input is what the test is about. `runTerminalCommand()` submits over IPC (`terminal.submit`) and bypasses the keyboard and the input pipeline entirely — setup only. `waitForTerminalText()` polls via `expect.poll()`, and `getTerminalViewport(page, panelId)` returns the rows actually on screen, for scroll and restore assertions.

### Actions (`e2e/helpers/actions.ts`)

`dispatchAction(page, actionId, args?, { source, confirmed })` dispatches through the renderer's `__daintreeDispatchAction` hook and returns the `ActionService` result as-is. It is a setup backdoor: a test of an action's user entry point goes through the menu, palette or keybinding. Use it instead of a local copy.

### Fake agents (`e2e/helpers/fakeAgent.ts`)

`installFakeAgent(repoDir, options)` installs a deterministic stand-in CLI and returns its bin dir; put it on the launch `PATH` with `fakeAgentEnv(binDir)`. `identity: "claude" | "codex"` picks which CLI it impersonates (version output, banner, interrupt semantics), `version` sets what `--version` reports, `bracketedPaste` and `rawInput` shape its tty, and `recordEnv` adds env names to each launch record. `perPane` and `controlChannel` let several instances share one binary and take commands through a file instead of stdin. Read what the app actually did with `readFakeAgentLaunchLog` (argv, cwd and env for every launch), `readFakeAgentStdinChunks` (every byte it received, timestamped), `readFakeAgentEvents` (SIGINT and interrupts), and drive a handback with `sendFakeAgentHandback`.

### Fault injection

Fault hooks exist only when the app is launched with `DAINTREE_E2E_FAULT_MODE=1`. `e2e/helpers/ipcFaults.ts` arms the main-process fault registry (`electron/ipc/faultRegistry.ts`) to make the next invoke on an IPC channel throw or stall. For real process death, `__daintreeGetPtyHostPid(windowId)` (a main-process global, reached through `app.evaluate`) returns the pty-host's pid so a spec can SIGKILL it; `core-pty-host-crash.spec.ts` is the worked example.

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

The comprehensive cross-platform surface, dispatched on demand by the `stabilize` skill (`.agents/skills/stabilize/`) — it replaced the old scheduled nightly. `workflow_dispatch` only (no cron), input `platform` defaulting to `linux-windows` (also `windows` | `linux` | `all` | `non-windows` | `macos`). One run executes `check`, unit `test`, `build` + smoke, `integration-test` (Linux legs only), and every E2E suite (`core`, all seven `full-*` buckets, `online`, and the `nightly` memory-leak soak) across the chosen platforms. All of those start in parallel — `check`/`test` do not gate E2E — so a single run surfaces every failure at once, and the app is built once per OS (`e2e-build`) and handed to every shard through `e2e.yml`'s `prebuilt_artifact` input. A second input, `only`, scopes a re-run to named pieces (e.g. `-f only='test full-terminal'`; aliases `full` and `e2e`), and the `stabilize-ok` gate accepts `skipped` only from pieces the run deliberately left out (via `only`, or `integration-test` on a run with no Linux leg). `knip` is not part of the workflow: it is OS-agnostic, so the skill runs it once locally. It opens no issues — the driving agent triages results from the per-shard `failed-specs-*` / `failure-report-*` artifacts and the `stabilize-merged-playwright-report`. Watch the single `stabilize-ok` gate for the overall verdict. The skill runs the full gate locally first on macOS, so CI defaults to `linux-windows` (no macOS); `windows` alone is the usual iteration target, and `all` (adds macOS-on-CI) is reserved for the rare macOS issue that can't be reproduced locally.

### Release Gating

Releases run as three independent per-OS workflows (`release-macos.yml`, `release-linux.yml`, `release-windows.yml`, #8052), each triggered by the same `v*` tag. Every workflow runs checks, unit tests, and that OS's e2e gates (`core` + the seven `full-*` buckets fanned out as a matrix + `online`) before that OS's platform packaging starts, then publishes that OS's artifacts to R2 the moment its own pipeline is green — a failed or hung OS only delays itself. Because each `full-*` bucket auto-shards inside `e2e.yml` (#8053 — Windows buckets fan out 8–12 ways, `full-plugins` 4), a full Windows bucket finishes in ~10min wall-time instead of ~39min serial, so Windows `full-*` now gates the Windows release (it no longer takes ~5–6 hours). Pre-release cross-platform confidence beyond what the release tag itself runs comes from `stabilize.yml` (the `stabilize` skill — normally `platform=linux-windows`, since the mandatory local run already covers macOS; `platform=all` only when a macOS-on-CI check is genuinely essential), not from a scheduled nightly — the test-nightly was retired and only `nightly-publish.yml` (binary publish, smoke only) still runs on a cron.

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
| `npm run test:e2e:core` | Playwright `core` project (3 e2e specs) | Release (all 3 OSes) | `release-{linux,macos,windows}.yml` |

`npm run test:smoke` launches the built Electron binary in `--smoke-test` mode and validates stability markers: node-pty native module load, renderer `did-finish-load`, IPC bridge round-trip, terminal stress rounds, and project persistence stress. It is a single-run soak (with configurable retries) — not a Playwright suite.

`npm run test:e2e:core` runs the 3 Playwright specs in `e2e/core/` against the Electron app. These are deterministic release-gate tests that gate every OS publish.

## `test:freeze-harness` — why it can't be a Playwright spec

`npm run test:freeze-harness` (`scripts/run-freeze-harness.mjs` + `electron/services/freezeHarness.ts`) measures whether a cached project view's renderer genuinely stops executing tasks when the efficiency-freeze path freezes it, resumes when it is thawed, and costs close to no CPU while cached and idle.

**Do not port this to Playwright.** Playwright sends `Emulation.setFocusEmulationEnabled` to every page target it attaches to. That handler takes out a `WebContents` capturer with `stay_hidden=false`, which permanently tells the renderer it is user-visible. `Page.setWebLifecycleState(frozen)` calls `WasHidden()` internally, so on a forced-visible page it no-ops — while still returning success. A freeze assertion written in Playwright passes whether or not freeze works, in every project view, always (#11846). A second CDP session can't undo it either: `capture_handle_` and `focus_emulation_enabled_` are per-session handler state.

The harness therefore boots the real app with no Playwright and no debugger client of its own — attaching one would collide with the `ensureAttached` inside `freezeWebContents`, land in `EXPECTED_CDP_ERRORS`, and be swallowed. The renderer counts its own `MessageChannel` tasks into wall-clock buckets; `webContents.executeJavaScript` (Blink script execution, not CDP) reads the timeline out **after** the thaw, because a frozen renderer cannot answer while frozen. Three legs are measured at equal width — cached-unfrozen, frozen, thawed — and the assertions are **ratios**, not timing bounds, because a bound goes red on a loaded box.

`MessageChannel` rather than a timer is deliberate: timers are subject to background throttling, which would confound "frozen" with "merely throttled".

```bash
npm run build && npm run test:freeze-harness
FREEZE_HARNESS_RUNS=5 npm run test:freeze-harness   # variance
```

The idle-CPU leg is the one deliberate bound (#12456). Task counts cannot see a CDP CPU throttle: `Emulation.setCPUThrottlingRate` busy-spins the renderer main thread from a signal handler, outside any task and frozen or not, so the freeze legs passed while every cached view burned 25–40% of a core. After the freeze legs the harness switches back to A, so B — never probed — is freshly cached with efficiency freeze off, then reads B's renderer `cpu.cumulativeCPUUsage` from `app.getAppMetrics()` across a 10 s window and requires under 10% of one core. It fails on a missing counter, a replaced process, a pid shared with the active view, or a window that closes past B's purge deadline. `percentCPUUsage` is not used because every other `getAppMetrics()` caller resets its interval.

All three measurement windows have to close before the cached view's first memory purge (`CACHED_VIEW_PURGE_DELAY_MS`, armed as the view is parked), or the purge perturbs the throughput being measured. The planned schedule is checked against the elapsed clock just before the control leg, and the actual finish is checked again after the last window — so widening `DAINTREE_FREEZE_HARNESS_WINDOW_MS` past what fits, or timers running long on a loaded box, fails the run with the shortfall rather than reporting a number measured across a purge.

Reference numbers (macOS, Electron 42, 3s windows): control ~54,000 ticks, frozen **0**, recovered ~52,000. With `freezeWebContents` neutered the same run reads control 54,026 / frozen 53,875 — a ratio of 1.0x against 54,000x, so the harness is discriminating by a wide margin.

**Freeze legs measured on macOS only.** The mechanism is Chromium/CDP semantics and should be platform-independent, but that is an inference; Windows is unverified and is the platform most likely to differ. The idle-CPU leg has not been run on any platform yet: its 10% ceiling comes from the 25–40% spin measured in #12456, so record the first real reading here. The harness is not wired into any workflow yet — run it on demand.

## Smoke Audit Cadence

The `core` Playwright project is the release-gate smoke — 3 specs that gate every OS publish. To ensure these 3 specs stay calibrated against real regressions, run a quarterly "kill rate" audit:

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
