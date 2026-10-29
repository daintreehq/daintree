---
paths:
  - "src/store/**"
  - "electron/store.ts"
  - "electron/services/persistence/**"
  - "electron/window/**"
  - "drizzle.config.ts"
  - "electron/services/StoreMigrations.ts"
  - "electron/services/migrations/**"
  - "electron/services/{PtyClient,WorkspaceClient}.ts"
  - "src/hooks/useWorktreeStore.ts"
---

# State and persistence

**Cross-store reads go through `src/store/storeAccessors.ts`** — never import a partner store at module eval (TDZ; see `docs/architecture/store-init-order.md`). Stores are app-global, except `createWorktreeStore`, the sole per-project-view factory.

Renderer state is per project view: each project gets its own `WebContentsView` and V8 context via `ProjectViewManager`, evicted LRU under memory pressure. Per-window services live in `WindowContext.services`; PtyClient and WorkspaceClient are shared globals.

**Durable state spans two engines with separate migrations:** better-sqlite3 + drizzle (`npm run db:generate`, output in `electron/services/persistence/migrations/` — never hand-written) and electron-store JSON (`electron/store.ts`).
