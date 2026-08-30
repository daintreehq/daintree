---
paths:
  - "electron/ipc/**"
  - "electron/preload.cts"
  - "shared/types/ipc/**"
  - "src/clients/**"
---

# IPC channels

`window.electron` exposes ~63 namespaces via `contextBridge` in `electron/preload.cts`; methods return Promises or cleanup functions. There are 68 `defineIpcNamespace` handler pairs.

## Adding a channel

1. Copy an existing handler pair — `electron/ipc/handlers/<domain>.ts` + `<domain>.preload.ts` (`editorConfig` is a clean, small example).
2. Assign the namespace in `electron/preload.cts`.
3. Run `npm run codegen:ipc && npm run codegen:ipc-renderer` — CI enforces this.

Generated: `shared/types/ipc/generated*.ts` — never hand-edited. Hand-maintained shapes: `shared/types/ipc/api.ts` and `maps.ts`. `src/types/electron.d.ts` is only the global shim.

`check:ipc-handwritten` is a ratchet that blocks new hand-wired channels. If it fires, you skipped the codegen path.

`check:channels` catches drift between handler and preload; `check:preload-backdoors` runs in CI's build job to confirm the E2E test surface was stripped from production.

## Boundaries

The renderer reaches Main **only** through `window.electron`. Direct `window.electron.*` calls bypass `ActionService`, so a destructive one must wire its own confirm and be logged in the destructive-action audit.

New forge IPC must implicitly activate the forge plugin — the lazy plugin is not activated by the IPC path on a cold start, which is what caused the forge cold-start count bug.

Reference: `docs/architecture/ipc-services.md`, `docs/development.md`.
