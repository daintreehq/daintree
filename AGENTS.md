# Repository Guidelines

## Project Overview

Electron-based IDE for orchestrating AI coding agents. Features terminal grid, worktree dashboard, and context injection.

## Project Structure

- `src/`: React 19 UI (components, hooks, Zustand stores, entry `main.tsx`/`App.tsx`).
- `electron/`: Main process (IPC handlers, preload, services, PTY host).
- `shared/`: Types and config shared between main and renderer.
- `docs/`: Product/feature specs.
- Tests: `__tests__` folders beside source files.

## Commands

```bash
npm run dev              # Vite UI + Electron main
npm run build            # Full production build
npm test                 # Vitest
npm run check            # typecheck + lint + format
npm run fix              # Auto-fix lint/format
```

## Critical Rules

1. **Dependencies:** Use `npm install`, never `npm ci` (package-lock is ignored).
2. **Code Style:** Minimal comments, no decorative separators, high signal-to-noise.
3. **Commits:** Conventional Commits (`feat(scope):`, `fix(scope):`, `chore:`).
4. **PRs:** Include brief summary, key changes, linked issues. Run `npm run check` first.
5. **Security:** No secrets in commits. Validate IPC inputs. Type all main/renderer boundaries.

## Key Architecture

### Actions System

Central dispatcher for all UI operations (`src/services/ActionService.ts`):

- `dispatch(actionId, args?)` - Execute actions by ID
- `list()` - Get MCP-compatible action manifest
- Definitions in `src/services/actions/definitions/`
- Types in `shared/types/actions.ts`

### Panel Architecture

Panels (terminal, agent, browser) use discriminated unions:

- `PanelInstance = PtyPanelData | BrowserPanelData`
- `panelKindHasPty(kind)` - Check if panel needs PTY
- Registry: `shared/config/panelKindRegistry.ts`

### IPC Bridge

Renderer accesses main via `window.electron` namespaced API.
Types in `src/types/electron.d.ts`, channels in `electron/ipc/channels.ts`.

## Coding Standards

- TypeScript everywhere. Explicit types for public APIs and IPC.
- Prettier: 2-space, double quotes, semicolons, trailing commas (es5), width 100.
- ESLint: React hooks rules, unused vars prefixed `_`, prefer `as const`.
- Components/hooks: `PascalCase`. Functions/vars: `camelCase`. Constants: `SCREAMING_SNAKE_CASE`.

## Testing

- Framework: Vitest. Files: `*.test.ts`/`*.test.tsx` in `__tests__/`.
- Mock IPC/process in tests. No network calls.
- Run `npm run test:watch` during dev, `npm test` before submit.
