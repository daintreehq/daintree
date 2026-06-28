# Development Reference

## Commands

```bash
npm install          # Install deps (or npm ci)
npm run dev          # Main + Renderer concurrent dev
npm run build        # Production build
npm run check        # typecheck + lint + format (run before commits)
npm run fix          # Auto-fix lint/format
npm run test         # Vitest once
npm run test:watch   # Vitest watch mode
npm run rebuild      # Rebuild node-pty for Electron
npm run package      # Build + electron-builder
```

## Architecture

```
Main Process (electron/)     Renderer (src/)
       │                           │
   Services ──IPC──> preload.cts ──> window.electron ──> Stores ──> Components
       │                                                    │
   node-pty, git, fs                                    Zustand
```

### Main Process (`electron/`)

| Path                | Purpose                      |
| ------------------- | ---------------------------- |
| `main.ts`           | Entry point, window creation |
| `preload.cts`       | IPC bridge via contextBridge |
| `ipc/channels.ts`   | Channel name constants       |
| `ipc/handlers.ts`   | Handler registration         |
| `ipc/handlers/*.ts` | Domain-specific handlers     |
| `services/`         | Business logic (see below)   |
| `schemas/`          | Zod validation for IPC       |

**Key Services:**

| Service | Responsibility |
| --- | --- |
| `PtyManager` | Terminal process pool, spawn/kill |
| `pty/TerminalProcess` | Single PTY wrapper, data flow |
| `pty/AgentStateService` | Idle/working/waiting detection |
| `pty/terminalInput` | Input submission and timing |
| `GitService` | Git operations via simple-git |
| `workspace-host/WorkspaceService` | Worktree polling and status (per-worktree tracking via `WorktreeMonitor`) |
| `CopyTreeService` | Context generation for agents |
| `PortalManager` | Localhost browser, log viewer |
| `ProjectStore` | Multi-project persistence |
| `HibernationService` | Terminal state save/restore |

### Renderer (`src/`)

| Path                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `components/Terminal/` | Xterm.js rendering, grid layout                    |
| `components/Worktree/` | Dashboard cards, status display                    |
| `components/Layout/`   | App shell, toolbar, dock                           |
| `components/Browser/`  | Browser panel (BrowserPane, toolbar)               |
| `components/Portal/`   | Localhost portal, dev-server dashboard, log viewer |
| `store/*.ts`           | Zustand stores                                     |
| `hooks/`               | React hooks for IPC subscriptions                  |
| `clients/`             | Typed wrappers for window.electron                 |

**Key Stores:**

| Store                 | State                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| `panelStore`          | Panel instances (`panelsById`), grid layout, focus                    |
| `terminalInputStore`  | Hybrid input bar state                                                |
| `worktreeStore`       | Active worktree, selection                                            |
| `createWorktreeStore` | Per-view worktree list + git status (factory, backed by MessagePorts) |
| `projectStore`        | Current project, project list                                         |
| `portalStore`         | Portal tabs, visibility                                               |

### Shared Types (`shared/types/ipc/`)

Type definitions shared between main and renderer. One file per domain: `terminal.ts`, `worktree.ts`, `project.ts`, etc.

## IPC Pattern

Adding new IPC:

1. **Channel**: Add to `electron/ipc/channels.ts`
2. **Types**: Add to `shared/types/ipc/<domain>.ts`
3. **Handler**: Create in `electron/ipc/handlers/<domain>.ts`, register in `handlers.ts`
4. **Preload**: Expose in `electron/preload.cts` under appropriate namespace
5. **Client**: Add typed wrapper in `src/clients/` if complex

IPC uses invoke/handle for requests, send/on for events. All handlers validate with Zod schemas.

## Testing

```bash
npm run test              # Run once
npm run test:watch        # Watch mode
npm run test -- --run src/components  # Filter by path
```

Tests live in `__tests__/` directories adjacent to source. Use Vitest. Mock IPC via `vi.mock()`.

## Debugging

**Renderer**: DevTools (Cmd+Opt+I). Console, Network, React DevTools.

**Main**: Logs to terminal running `npm run dev`. Use logger:

```typescript
import { logInfo, logError } from "./utils/logger";
logInfo("message", { data });
logError("message", error, { data });
```

**Common fixes:**

- PTY errors: `npm run rebuild`
- Type errors in electron/: `npm run build:main`
- Stale cache: `rm -rf node_modules/.vite && npm run dev`

## Agent startup profiling

Two pieces of dev-only instrumentation help diagnose slow agent CLI launches.

### Structured startup metrics

Every agent terminal logs a single `[AgentStartup]` line to the pty-host console as soon as boot completion is detected. The line is JSON keyed on `(agentId, cwdHash)` so traces from different launches in the same project can be compared:

```text
[AgentStartup] {"agentId":"claude","cwdHash":"a1b2c3d4","terminalId":"...","spawnedAt":1700000000000,"firstByteAt":1700000000180,"bootCompleteAt":1700000000420,"bootDurationMs":420,"timeToFirstByteMs":180}
```

`firstByteAt` and `timeToFirstByteMs` are omitted when boot completion fires before any PTY output (timeout-only path). The fields `firstByteAt` and `bootCompleteAt` are also surfaced on the terminal's `getPublicState()` payload for tooling that needs to read them programmatically.

### CPU profiling

For deeper investigations, the agent CLI can be CPU-profiled by Node's built-in profiler.

1. Set `DAINTREE_PROFILE_AGENT_STARTUP=1` in the shell that launches the dev build (`npm run dev`).
2. Spawn an agent terminal as usual.
3. Find the resulting `*.cpuprofile` file under `<userData>/agent-profiles/` (`~/Library/Application Support/Daintree/agent-profiles/` on macOS).
4. Open Chrome DevTools → Performance → Load profile, or use the same workflow in VS Code.

The flag is gated on `app.isPackaged === false` (forwarded to the pty host as `DAINTREE_IS_PACKAGED=0`). Packaged builds never honour the flag.

`NODE_OPTIONS=--cpu-prof --cpu-prof-dir=...` is inherited by every Node.js subprocess the agent spawns (npm, tsc, MCP servers). The output directory will accumulate profiles for those subprocesses too — filter by filename or PID when analysing.

## CI

`.github/workflows/ci.yml` runs on push/PR to `main` and `develop`:

1. **check** (Ubuntu): typecheck + lint + format (`npm run check`)
2. **test** (Ubuntu): vitest unit tests, sharded 4 ways
3. **build** (Ubuntu only): production build verification
4. **ci-ok**: aggregate gate that fails if any job failed — the sole required status check

`check` and `test` default to Ubuntu on push/PR but can opt into Windows via `gh workflow run CI -f os=windows` (or `os=both`). Cross-platform build, smoke, and E2E live in `stabilize.yml` — the on-demand, agent-driven workflow (and the `stabilize` skill that drives it) that replaced the scheduled nightly; releases run per-OS via `release-macos.yml` / `release-linux.yml` / `release-windows.yml`. The only thing still on a nightly cron is `nightly-publish.yml`, which builds and publishes the macOS/Linux nightly auto-update binaries and runs no test suites (only a launch smoke before publishing).

## Compiler bailout tooling

React Compiler bailouts are tracked with two complementary tools. These run locally on demand — like the other budget scripts, the compiler budget is intentionally not wired into CI pre-1.0 (see the dormancy note in `.github/workflows/ci.yml`); the "gate" framing below describes how the check behaves when run and how it is designed to gate CI once budgets are reintroduced post-1.0.

```bash
npm run compiler-budget:check     # Check: diffs build report against baseline (catches ALL regressions)
npm run compiler-budget:critical  # Triage: re-runs compiler with severity:"Error" filter (surfaces real bailouts only)
npm run compiler-budget:update    # Accept: refreshes baseline after intentional regressions
```

The **budget check** (`compiler-budget:check`) is severity-aware. Severity is derived dynamically from the plugin's exported `LintRules` registry (1 `Hint` category `Todo`, 2 `Warning`, 23 `Error` as of `babel-plugin-react-compiler` 1.0.0), so a plugin upgrade that recategorizes a rule reflows the gate automatically. Per `CompileError` event, the gate buckets by severity:

- **`Hint` (cosmetic `Todo` noise — try/catch lowering, dynamic-import arrows):** collapsed to a single per-file `hintCount`, not stored verbatim. This keeps `compiler-bailout-baseline.json` compact — a shifting Todo count is a one-line diff instead of dozens of repeated reason strings. Gated only by a **global Hint budget**: per-file churn moves freely (a refactor shifting noise between files nets to zero), but the whole-repo total may not grow.
- **`Error` + `Warning` (load-bearing rule-of-React violations):** tracked verbatim in `errorBailouts` (with `category`, `severity`, `reason`) and protected by a **strict zero-regression gate** — any per-file increase, any new file with a strict bailout, or any growth in the whole-repo strict total fails the check (and will fail CI once budgets gate CI post-1.0).

The raw `error` count is kept per file for diagnostics but no longer gates directly. The **critical-errors script** (`compiler-budget:critical`) re-runs the React Compiler directly on `src/` and filters to `severity: "Error"`, isolating the small subset of diagnostics that actually affect optimization. Run it when the budget gate fires to determine whether the new bailout is cosmetic noise or needs attention.

Both tools use `panicThreshold: "none"` — the signal lives in the report and the triage script, never in build crashes.

Refresh the baseline with `npm run compiler-budget:update` when a regression is intentional. The 10% shrinkage guard counts file keys (not entry shape), so the one-time severity-aware reformat doesn't trip it; `--force` is only needed if the file count genuinely drops by more than 10%.

## Code Patterns

**Service → IPC → Store → UI**: All features follow this flow. Main-process services don't import from renderer. Stores reach the main process through the typed clients in `src/clients/`, not by importing main-process services.

**Event subscriptions**: Renderer subscribes via `window.electron.<namespace>.on*()`. Returns cleanup function. Always clean up in useEffect.

**Multi-project**: Services filter by `projectId`. Stores reset on project switch. Check `projectStore.currentProject` before operations.

**Error handling**: Services throw typed errors. IPC handlers catch and return error objects. UI displays via `errorStore`.

## Plugins

Plugin authoring is documented separately in [`./plugins/README.md`](./plugins/README.md).
