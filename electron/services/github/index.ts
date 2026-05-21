/**
 * Compat shim — the GitHub services were rehomed into the
 * `daintree.github` built-in plugin at `plugins/builtin/github/main/` (#8060).
 * This barrel keeps the existing `electron/services/github/*` import paths
 * working for callers that have not yet migrated to the forge-provider
 * surface — primarily the `window.electron.github.*` IPC handlers in
 * `electron/ipc/handlers/github.ts`. Slated for removal after #8063 lands.
 *
 * Singleton identity is preserved across the electron main bundle and the
 * loaded plugin bundle because both entries participate in the same esbuild
 * build with `splitting: true`, so the underlying modules become a single
 * shared chunk that both consumers reference.
 */
export * from "../../../plugins/builtin/github/main/index.js";
