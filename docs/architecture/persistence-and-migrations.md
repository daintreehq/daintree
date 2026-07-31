# Local persistence: SQLite store & migrations

## Purpose

Daintree persists local state across two unrelated engines, each with its own file, its own migration mechanism, and its own failure/recovery story. This doc maps what lives where, how each layer migrates, and the lifecycle ordering that keeps a long-running session from corrupting or leaking disk. It exists so a future change to "where does X persist" doesn't require reverse-engineering `electron/store.ts`, `electron/services/persistence/`, and `electron/services/migrations/` in parallel.

The two engines are easy to conflate because both have a `migrations/` directory and both call their journal a "schema version." They are not the same system. Keep them separate in your head:

| Layer | Engine | File (in `userData`) | Migration system | Versioned by |
| --- | --- | --- | --- | --- |
| Main settings store | `electron-store` (JSON) | `config.json` (+ `.bak`) | `electron/services/migrations/*.ts` (numbered TS) | `_schemaVersion` key, integer |
| Window-states store | `electron-store` (JSON) | `window-states.json` | none of its own; written by store migration 020 | n/a |
| App database | SQLite via `better-sqlite3` + Drizzle | `daintree.db` (+ `-wal`, `-shm`, `.backup`) | `electron/services/persistence/migrations/*.sql` (Drizzle) | `__drizzle_migrations` table + `meta/_journal.json` |

## Mental model

- **`config.json`** is the big, schema-loose settings blob: terminal config, hibernation, notification settings, plugin disable lists, onboarding, app agent config, audit logs, frecency, secrets-adjacent metadata. It is a single JSON document managed by `electron-store`. Migrations are hand-written TypeScript that mutate the live document in place and bump `_schemaVersion`.
- **`window-states.json`** is a small dedicated `electron-store` carved out of the main store (store migration 020) so per-project window geometry doesn't churn the main config file on every move/resize. It has no migration chain of its own.
- **`daintree.db`** holds the relational, query-shaped data: the `projects` table (frecency/pinning/MRU switching), `app_state` key-value rows (notably `currentProjectId`), and `scratches`. This is real SQLite with WAL, a backup file, corruption probing, and Drizzle SQL migrations.

The split is deliberate: anything that benefits from indexed queries, atomic row updates, or crash-safe relational state lives in SQLite; everything else stays in the JSON store where ad-hoc nested objects are cheap.

## Layer 1 — the electron-store JSON layer

### Stores and files

Defined in `electron/store.ts`:

- `store` (`export const store`) — the main store, a `Proxy` over a lazily/explicitly initialized `Store<StoreSchema>`. `StoreSchema` is the large interface starting at `electron/store.ts:46`. Default config file name is `electron-store`'s default (`config.json`), `configFileMode: 0o600`, `clearInvalidConfig: true`.
- `windowStatesStore` (`export const windowStatesStore`) — `name: "window-states"` → `window-states.json`, schema `WindowStatesStoreSchema` (`electron/store.ts:42`).

`initializeStore()` (`electron/store.ts:750`) is called explicitly during boot (before any module reads `store`). It runs a corruption pre-flight (`preflightValidateConfig` → quarantine + `restoreFromBackup`), detects electron-store silently wiping the file during construction, tightens file permissions to `0o600`, and falls back to an in-memory store on hard failure (recording a `pendingSettingsRecovery` reason surfaced to the renderer). `tightenFilePermissions` (`electron/store.ts:665`) is the shared owner-only chmod helper used across the store, its `.bak`, and migration backups.

### Migration framework

The migration runner is `MigrationRunner` in `electron/services/StoreMigrations.ts`. Each migration is a `Migration` object:

```ts
export interface Migration {
  version: number;
  description: string;
  up: (store: Store<StoreSchema>) => void | Promise<void>;
}
```

Migrations are individual files `NNN-name.ts` in `electron/services/migrations/`, each exporting `migrationNNN`, and registered (imported + listed) in `electron/services/migrations/index.ts`. `LATEST_SCHEMA_VERSION` lives at the top of `StoreMigrations.ts` and must track the highest registered migration — a test asserts the two agree, so read the constant rather than trusting any number quoted here.

**Current chain** (`index.ts`, verified against the tree):

| Version | File                                                                   |
| ------: | ---------------------------------------------------------------------- |
|     002 | `002-add-terminal-location.ts`                                         |
|     003 | `003-migrate-recipes-to-project.ts`                                    |
|     004 | `004-upgrade-correction-model.ts`                                      |
|     005 | `005-add-getting-started-checklist.ts`                                 |
|       — | _006 removed in #5150 (gap is intentional; see comment in `index.ts`)_ |
|     007 | `007-reduce-default-terminal-scrollback.ts`                            |
|     008 | `008-split-notification-sounds.ts`                                     |
|     009 | `009-per-project-window-state.ts`                                      |
|     010 | `010-add-working-pulse-setting.ts`                                     |
|     011 | `011-minimal-soundscape-defaults.ts`                                   |
|     012 | `012-default-pin-agents.ts`                                            |
|     013 | `013-cleanup-phantom-pins.ts`                                          |
|     014 | `014-consolidate-telemetry-consent.ts`                                 |
|     015 | `015-activation-funnel-and-checklist-rename.ts`                        |
|     016 | `016-rename-flavor-to-preset.ts`                                       |
|     017 | `017-add-notification-quiet-hours.ts`                                  |
|     018 | `018-archive-notes.ts`                                                 |
|     019 | `019-remove-fleet-deck-open.ts`                                        |
|     020 | `020-window-states-store.ts`                                           |
|     021 | `021-merge-disabled-plugins.ts`                                        |

There is no `001`; the chain starts at `002`. Migration files are numbered, not strictly contiguous — `006` is a permanent gap.

### How a migration runs

Invoked from `initGlobalServices` (`electron/window/globalServicesInit.ts:138`) on first window setup:

1. `new MigrationRunner(store)`; read `getCurrentVersion()`.
2. **Lazy load.** Only if `currentVersion !== LATEST_SCHEMA_VERSION` does it `await import("../services/migrations/index.js")` — the common (up-to-date) case skips parsing the migration barrel entirely.
3. `runMigrations(migrations)` (`StoreMigrations.ts:181`):
   - **Disk-space gate.** Throws immediately if `getCurrentDiskSpaceStatus().status === "critical"` — the pre-migration backup and electron-store's atomic write both fail hard on a full volume, so it refuses to partially mutate.
   - **Downgrade guard.** If the on-disk `_schemaVersion` is _ahead_ of `maxKnownVersion` (store written by a newer build), it logs a compatibility warning and returns without touching anything, relying on additive-only schema design (unknown keys ignored, higher version preserved).
   - **Backup.** `backupStore()` copies `config.json` to `config.json.backup-v<from>-<ts>` (owner-only) before applying anything.
   - **Apply.** Pending migrations run sorted ascending; after each, `_schemaVersion` is set to that migration's version (so a crash mid-chain resumes correctly).
   - **Validate.** `PostMigrationSanitySchema` (a `.passthrough()` Zod check) asserts `_schemaVersion` is a non-negative integer.
   - **Rollback on failure.** Any throw triggers `restoreFromBackup`: the failed-migration state is preserved at `config.json.failed-<ts>`, then the backup is atomically renamed back over the live store. The failure is re-thrown as a `StoreMigrationError` carrying `backupPath`, `failedStatePath`, `restored`, `restoreError`.
4. If migration throws, `globalServicesInit` shows a `dialog.showErrorBox`, calls `app.exit(1)`, and returns `"exit-requested"` — **the caller must early-return.** A failed migration is fatal, not silently skipped.

### Authoring & idempotency expectations

Every migration `up` is written to be **idempotent and defensive**, because a partial prior run, a manually edited store, or an older build can leave the document in any shape:

- Read the current value, type-check it (`typeof x === "object"`, `Array.isArray`), and **skip** (log + early return) when the target shape is already present. Example: `017-add-notification-quiet-hours.ts` builds a `patch` only for fields that are missing and returns early when the patch is empty.
- Drop legacy keys via `store.delete(key)`, **never** `store.set(key, undefined)` — electron-store v11 throws on `undefined` values (see the comment in `020-window-states-store.ts`, ref #2727).
- Cross-store migrations are allowed: `020` reads `windowStates`/`windowState` from the main `store`, merges into `windowStatesStore`, then deletes the legacy keys from the main store.
- Preserve user intent across renames/merges: `021-merge-disabled-plugins.ts` merges the legacy `plugins.disabledBuiltins` into the unified `plugins.disabled` list (deduped) and strips the legacy key. Note the schema keeps `disabledBuiltins` as an `@deprecated` optional field so `clearInvalidConfig` doesn't strip it _before_ this migration runs.

**To add a migration:** create `electron/services/migrations/NNN-name.ts` exporting `migrationNNN` (next integer, even though gaps are tolerated), add the import + list entry in `index.ts`, and bump `LATEST_SCHEMA_VERSION` in `StoreMigrations.ts`. Tests live in `electron/services/migrations/__tests__/`.

## Layer 2 — the SQLite database

### Engine: better-sqlite3 + Drizzle (not a native Electron binding)

Persistence uses **`better-sqlite3`** (synchronous, in-process) wrapped by **Drizzle ORM** (`drizzle-orm/better-sqlite3`). The schema is defined in `electron/services/persistence/schema.ts` as Drizzle table definitions; migrations are generated SQL.

Do not confuse the build change in #9254 with a runtime engine change. better-sqlite3 is still the engine. What #9254 (`feature/issue-9254-drop-better-sqlite3-electron`) changed is the _build_ path: better-sqlite3 was **dropped from the `electron-rebuild` step** in favor of **prebuilt binaries via `prebuild-install`** (see `scripts/postinstall.cjs`). In CI/release (`npm_config_runtime=electron` + `npm_config_target` set), `prebuild-install` fetches the correct Electron-ABI binary directly; for local Node-tool runs it defaults to the Node ABI, and the postinstall probe rebuilds for Electron only when needed. The migration SQL is shipped inside `app.asar` (#9403 ASAR integrity work), located at runtime via `getMigrationsFolder()` → `path.join(app.getAppPath(), "electron/services/persistence/migrations")`.

The synchronous nature is intentional and load-bearing: it lets the early-boot reader (below) and project-switch state saves run without async plumbing. Several `eager-import-allow` comments and the watchdog/host-fork ordering exist specifically because a synchronous better-sqlite3 op can pause the main thread (`electron/watchdog-host-core.ts`).

### Schema

`electron/services/persistence/schema.ts` — three tables:

- `projects` — `id, path, name, emoji, last_opened, color, status, daintree_config_present, in_repo_settings, pinned, frecency_score, last_accessed_at`. Drives the project list, frecency ranking, pinning, and MRU switching (`electron/services/ProjectStore.ts`).
- `app_state` — `(key, value)` key-value text rows. Holds `currentProjectId` among others.
- `scratches` — `id, path, name, created_at, last_opened, deleted_at`. `deleted_at` is a tombstone: the auto-cleanup sweep marks a stale scratch, the row is retained as crash-safe state so a partially-deleted dir can be re-attempted next boot, and tombstoned rows are filtered out of renderer-facing queries (`electron/services/ScratchStore.ts`).

### Open path, pragmas, and recovery

`electron/services/persistence/db.ts` is the whole lifecycle:

- `getDbPath()` → `userData/daintree.db`; `getBackupPath()` → `daintree.db.backup`.
- `getSharedDb()` / `getSharedSqlite()` — singleton accessor; opens lazily via `openDb()`.
- `openDb()`:
  - **Disk gate.** Throws if `getWritesSuppressed()` (from `diskPressureState.ts`) — the `better-sqlite3` constructor creates the file on open, and a zero-byte DB on a critical volume would get quarantined as "corrupt" next boot.
  - Sets pragmas: `journal_mode=WAL`, `busy_timeout=3000`, `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size`, `cache_size=-65536`, `journal_size_limit=5242880`, `foreign_keys=ON`.
  - `adoptLegacyProjectColumns()` — one-time bootstrap for pre-`__drizzle_migrations` databases. SQLite has no `ADD COLUMN IF NOT EXISTS` and the baseline migration is a no-op for an existing `projects` table, so a legacy DB would never gain `pinned`/`frecency_score`/`last_accessed_at`. This detects "no migrations table + projects table present" and patches the columns before Drizzle takes over. After the baseline is recorded it's a fast skip.
  - Runs Drizzle `migrate(db, { migrationsFolder })`.
  - Backfills `last_accessed_at = now()` for rows still at the default `0` (so the frecency time-decay term doesn't crash a fresh row's score to ~0).
- `probeDb(dbPath)` — read-only `PRAGMA quick_check`; returns `false` on corruption (prefix-matched `SQLITE_CORRUPT*` / `SQLITE_NOTADB`), `true` for a missing file (fresh start) or non-corruption errors.
- `attemptRecovery(dbPath)` — quarantines the corrupt DB + WAL + SHM to `.corrupt-<ts>`, then restores from `.backup` if the backup itself probes clean.
- `withDiskRecovery(sqlite, fn)` — runs `fn`; on `SQLITE_FULL` or a write-side `SQLITE_IOERR_*` (`WRITE`/`FSYNC`/`TRUNCATE`/`DIR_FSYNC`) it truncates the WAL and retries **once**, gated on disk status.
- `closeSharedDb({ checkpoint })` — optional `wal_checkpoint(TRUNCATE)` then close.

### Drizzle migrations

SQL files in `electron/services/persistence/migrations/`, tracked by Drizzle's journal in `meta/_journal.json` and recorded in the DB's `__drizzle_migrations` table:

| Tag                           | File                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `0000_baseline`               | `0000_baseline.sql`                                            |
| `0001_add_scratches`          | `0001_add_scratches.sql`                                       |
| `0002_add_scratch_deleted_at` | `0002_add_scratch_deleted_at.sql`                              |
| `0003_drop_tasks`             | `0003_drop_tasks.sql` (drops the dead `tasks` table + indexes) |

These are **generated**, not hand-written: edit `schema.ts`, then `npm run db:generate` (`drizzle-kit generate`); `npm run db:check` validates the journal. Do not edit applied SQL by hand.

## Early-boot read: `readLastActiveProjectIdSync`

`electron/services/persistence/readLastProjectId.ts` exports `readLastActiveProjectIdSync()`, called from `electron/main.ts:223` **before any window is created**. It opens its **own read-only** `better-sqlite3` connection (independent of `getSharedDb()` / `ProjectStore.initialize()`), reads `app_state` where `key='currentProjectId'`, and returns `null` on first launch, missing table, or any error.

Why a separate connection: the initial `WebContentsView` needs the correct session partition _before_ `app.whenReady()` fully wires the shared DB, so the first render gets crash isolation and V8 code-cache benefits. Any failure here is a safe fallback to the default session — the full DB init in window setup handles real recovery.

## Maintenance & shutdown ordering (long-session disk growth)

### DatabaseMaintenanceService

`electron/services/DatabaseMaintenanceService.ts` — singleton, two-phase init:

- **`initialize()`** runs synchronously in `main.ts` (dynamic-imported there, #8817, to keep the static boot graph lean) _before_ the shared DB is opened. It runs `probeDb` → `attemptRecovery` so a corrupt file is quarantined/restored before anything queries it.
- **`startMaintenance()`** is deferred to the `database-maintenance` task in `globalServicesInit` (drains after first-interactive), arming a 5-minute tick and a `SystemSleepService.onSuspend` checkpoint.
- **`tick()`** is **idle-gated** (`powerMonitor.getSystemIdleTime() >= 60s`): `wal_checkpoint(TRUNCATE)` then a backup. `runBackup()` does `sqlite.backup(tmp)` then atomic `rename` to `daintree.db.backup`, with single-in-flight guarding.

### PeriodicCleanupService — periodic disk-reclamation sweep

`electron/services/PeriodicCleanupService.ts` (#9537) exists because the three boot-time reclamation routines — `runScratchCleanup`, `runAssistantScratchCleanup`, `pruneOldLogs` — otherwise run **once at startup and never again**, so a multi-day session steadily accumulates stale scratch dirs, orphaned assistant scratch, and old logs. This service re-invokes all three on a **4-hour** timer, **idle-gated at 60s**, with an `inFlight` guard (the routines are async and the disk-pressure critical-edge trigger in `globalServicesInit` can fire the same routines concurrently). It mirrors `DatabaseMaintenanceService`'s shape (idle gate, `disposed` guard, shutdown-wired disposal).

### Drain-in-flight-before-dispose ordering

The shutdown sequence (`electron/lifecycle/shutdown.ts`) is ordered so no background tick races the final WAL checkpoint or closes the DB mid-write:

```
1. PeriodicCleanupService.dispose()   # stop timer, AWAIT in-flight sweep   (#9537)
2. DatabaseMaintenanceService.dispose()
      - stop timer + remove suspend listener
      - AWAIT in-flight backup (this.backupPromise)
      - final runBackup() + PRAGMA optimize + wal_checkpoint(TRUNCATE)
      - does NOT close the DB
3. closeSharedDb()                     # actual sqlite.close()
```

Two invariants make this correct:

- **`DatabaseMaintenanceService.dispose()` does not close the connection.** `shutdown.ts` may still need the DB for project-state saves _after_ maintenance disposes, so the close is a separate, later step (`closeSharedDb()`). The dispose method's comment calls this out explicitly.
- **Cleanup drains before DB maintenance, which drains before close.** `PeriodicCleanup` is disposed first and awaits its in-flight pass so a slow `hardDeleteScratch` can't still be writing when the WAL is truncated; `DatabaseMaintenance` then awaits its own in-flight backup before the final TRUNCATE checkpoint; only then does `closeSharedDb()` run. The final `TRUNCATE` checkpoint is what actually folds the WAL back into the main DB file so the next launch opens a compact, fully-checkpointed database — the mechanism that prevents unbounded `-wal` growth across long sessions.

## Pointers

- Main JSON store + window-states store: `electron/store.ts`
- Store migration runner + error/rollback types: `electron/services/StoreMigrations.ts`
- Store migrations + registration: `electron/services/migrations/`, `electron/services/migrations/index.ts`
- SQLite open/probe/recover/disk-recovery: `electron/services/persistence/db.ts`
- SQLite schema (Drizzle tables): `electron/services/persistence/schema.ts`
- Generated SQL migrations + journal: `electron/services/persistence/migrations/`, `.../migrations/meta/_journal.json`
- Early-boot project-id read: `electron/services/persistence/readLastProjectId.ts`
- Relational stores over the DB: `electron/services/ProjectStore.ts`, `electron/services/ScratchStore.ts`
- DB maintenance: `electron/services/DatabaseMaintenanceService.ts`
- Periodic reclamation sweep: `electron/services/PeriodicCleanupService.ts`
- Boot wiring (migration run + maintenance arm): `electron/window/globalServicesInit.ts`; pre-window probe + early read: `electron/main.ts`
- Shutdown ordering: `electron/lifecycle/shutdown.ts`
- Build/native-module handling: `scripts/postinstall.cjs`

## See also

- [State management](state-management.md) — renderer-side store topology and how persisted state hydrates the UI.
- [Store init order](store-init-order.md) — the precise boot-time ordering constraints around the main store.
- [Development guide](../development.md) — architecture overview, IPC patterns, and debugging.
