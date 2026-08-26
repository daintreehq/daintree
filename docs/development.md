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

**Renderer**: DevTools (View → Toggle Developer Tools, or the Toggle DevTools command; dev builds only). Console, Network, React DevTools.

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

React Compiler bailouts are tracked with two tools that share **one collector**: `scripts/lib/compiler-scan.mjs` runs the compiler over a declared set of files on disk, under the options `vite.config.ts` passes to `reactCompilerPreset`. Each command performs its own scan (~20s over ~1,500 files, with progress on stderr); neither needs a build. These run locally on demand — like the other budget scripts, the compiler budget is intentionally not wired into CI pre-1.0 (see the dormancy note in `.github/workflows/ci.yml`); the "gate" framing below describes how the check behaves when run.

```bash
npm run compiler-budget:check     # Gate: diffs the scan against the baseline
npm run compiler-budget:critical  # Triage: the same scan, filtered to severity "Error"
npm run compiler-budget:update    # Accept: rewrites the baseline from the scan
```

**Scope** is declared in one place, `scripts/lib/compiler-scan-surface.mjs`: `src/**/*.{ts,tsx}` plus `plugins/builtin/*/renderer/**/*.{ts,tsx}`, minus `*.test.*`, `*.spec.*`, `__tests__/` and `.d.ts`. `plugins/sample/**` is excluded because it builds through its own Vite config that never registers the compiler. The scan reuses the preset's own source filter; Rolldown's per-extension parser options are mirrored by hand (`.ts` deliberately parses without the `jsx` plugin, or `<T>(x)` would be read as a JSX element), and the fingerprint records that mirroring so a change on either side invalidates the baseline.

`vite.config.ts` also holds the build to that same surface: if the compiler ever processes a renderer file outside it, the build fails naming the file. Without that, moving renderer code to a new root would retire its debt silently — the old path reads as deleted and the new path is simply never scanned.

**Why a scan and not the build.** The gate used to read a logger threaded into `vite build`. That measures whatever the module graph reaches, which moves with tree-shaking, dynamic imports and entry changes — and it was never "the files that ship" either, since most of what the compiler transforms is tree-shaken out of the emitted chunks afterwards. React Compiler diagnostics are file-local, so the file on disk is the honest unit. When this was introduced the scan reproduced every file the build reported with identical per-file counts, plus eight the bundler had tree-shaken away.

**Severity buckets** are derived from the plugin's exported `LintRules` registry, so a plugin upgrade that recategorizes a rule reflows the gate:

- **`Hint` (cosmetic `Todo` noise):** collapsed to a per-file `hintCount` and gated only by a **global budget**. Per-file churn moves freely; the whole-repo total may not grow. Entries for deleted files are excluded from that ceiling — their budget left with the code.
- **`Error` + `Warning`:** tracked verbatim in `errorBailouts` and gated **strictly** — any per-file increase, any new file with a strict bailout, or any count-neutral swap to a different category fails.

**A baseline entry with nothing to report is three different events**, and the gate resolves which by asking the filesystem and the scan:

| Situation | Outcome |
| --- | --- |
| File deleted from the repo | Entry retired, its Hint budget retired with it |
| File scanned, now clean — or no longer holding React code | Entry retired as an improvement |
| File on disk but the scan never decided about it | **Failure** — coverage was lost |

Only the third fails. Treating all three as failures is what made contributors hand-edit the baseline instead of regenerating it, and hand-editing is how it silently stopped covering 190 files between June and August 2026. "Retired" describes the comparison, not the file — `check` never rewrites the baseline; `--update` is the only writer.

The baseline is versioned and carries a **fingerprint** of everything that changes what the numbers mean: the collector's own revision, the installed versions of the compiler, Babel, `@vitejs/plugin-react` and glob, the compiler options, the patterns and ignores, the source filter, the mirrored parser options, and the Hint category list. A mismatch is refused rather than migrated. A version that cannot be resolved fails the scan rather than being recorded as "unknown" — banking "unknown" once would make every later unknown compare equal to it.

The gate is **fail-closed** about its own collection. A file that cannot be read or parsed fails the run outright, because a hole in the scan reports as "clean". A scan that compiles files but records no diagnostics at all fails both modes, because it would otherwise read as the whole repo becoming clean. And a scan whose coverage falls more than 10% short of what the baseline implies should still be there, after allowing for deleted files, fails both modes rather than being written into a new baseline. That shortfall is measured against the baseline's recorded `scanned` count while only files with diagnostics are named in it, so an honest bulk deletion of clean files can trip it; `--update --accept-coverage-drop` downgrades it to a warning for that case, and has no effect in check mode, which stays fail-closed.

The baseline also records a **coverage** block (`discovered` / `scanned` / `filtered` / `withEvents`). It is what the collapse guard compares against; without it a silent collector is indistinguishable from a codebase that got clean.

`compiler-budget:critical` exits 0 when the scan **completed**, not when it found nothing — findings may still be listed. It exits 1 only when the listing is incomplete.

`vite.config.ts` keeps a minimal `reactCompilerReportPlugin` that writes nothing and only asserts the compiler is still wired into the real build.

Note that a **third**, separate compiler signal exists: CI ratchets `react-compiler/react-compiler` ESLint warnings against `scripts/baselines/eslint-warnings-baseline.json`. That runs `eslint-plugin-react-compiler` 19.1.0-rc.2, which bundles different compiler behaviour, disables ref-access validation, and reports only its default levels. It is not the same signal as the Babel compiler 1.0.0 scan above, and the two are not expected to agree.

## Code Patterns

**Service → IPC → Store → UI**: All features follow this flow. Main-process services don't import from renderer. Stores reach the main process through the typed clients in `src/clients/`, not by importing main-process services.

**Event subscriptions**: Renderer subscribes via `window.electron.<namespace>.on*()`. Returns cleanup function. Always clean up in useEffect.

**Multi-project**: Services filter by `projectId`. Stores reset on project switch. Check `projectStore.currentProject` before operations.

**Error handling**: Services throw typed errors. IPC handlers catch and return error objects. UI displays via `errorStore`.

## Plugins

Plugin authoring is documented separately in [`./plugins/README.md`](./plugins/README.md).
