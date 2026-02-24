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

| Service                    | Responsibility                    |
| -------------------------- | --------------------------------- |
| `PtyManager`               | Terminal process pool, spawn/kill |
| `pty/TerminalProcess`      | Single PTY wrapper, data flow     |
| `pty/AgentStateService`    | Idle/working/waiting detection    |
| `pty/terminalInput`        | Input submission and timing       |
| `GitService`               | Git operations via simple-git     |
| `worktree/WorktreeService` | Worktree polling and status       |
| `CopyTreeService`          | Context generation for agents     |
| `SidecarManager`           | Localhost browser, log viewer     |
| `ProjectStore`             | Multi-project persistence         |
| `HibernationService`       | Terminal state save/restore       |

### Renderer (`src/`)

| Path                   | Purpose                            |
| ---------------------- | ---------------------------------- |
| `components/Terminal/` | Xterm.js rendering, grid layout    |
| `components/Worktree/` | Dashboard cards, status display    |
| `components/Layout/`   | App shell, toolbar, dock           |
| `components/Sidecar/`  | Browser panel, artifact viewer     |
| `store/*.ts`           | Zustand stores                     |
| `hooks/`               | React hooks for IPC subscriptions  |
| `clients/`             | Typed wrappers for window.electron |

**Key Stores:**

| Store                | State                         |
| -------------------- | ----------------------------- |
| `terminalStore`      | Panel instances, grid layout  |
| `terminalInputStore` | Hybrid input bar state        |
| `worktreeStore`      | Active worktree, selection    |
| `worktreeDataStore`  | Worktree list, git status     |
| `projectStore`       | Current project, project list |
| `sidecarStore`       | Sidecar tabs, visibility      |

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
logInfo("ServiceName", "message", { data });
```

**Common fixes:**

- PTY errors: `npm run rebuild`
- Type errors in electron/: `npm run build:main`
- Stale cache: `rm -rf node_modules/.vite && npm run dev`

## CI

GitHub Actions on push/PR to main:

1. **quality** (Ubuntu): typecheck, lint, format, test
2. **build-macos/linux/windows**: Cross-platform build verification

Windows requires `GYP_MSVS_VERSION=2022` for node-pty compilation.

## Code Patterns

**Service → IPC → Store → UI**: All features follow this flow. Services don't import from renderer. Stores don't call services directly.

**Event subscriptions**: Renderer subscribes via `window.electron.<namespace>.on*()`. Returns cleanup function. Always clean up in useEffect.

**Multi-project**: Services filter by `projectId`. Stores reset on project switch. Check `projectStore.currentProject` before operations.

**Error handling**: Services throw typed errors. IPC handlers catch and return error objects. UI displays via `errorStore`.
