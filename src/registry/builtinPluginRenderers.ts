/**
 * Eager auto-discovery of built-in plugin renderer entries. Every
 * `plugins/builtin/<name>/renderer/index.ts(x)` is imported for its side
 * effects: registering the plugin's builtin view slots (e.g. the GitHub
 * plugin's bulkCreateWorktreeDialog, issueSelector) at module-eval time,
 * before first render. Must stay eager — a deferred/idle import races the
 * user, so getBuiltinView returns null and plugin-contributed dialogs
 * silently never open. Adding a new built-in plugin requires no edit here.
 *
 * Treeshake coupling: this module and the renderer entries it globs are
 * listed in package.json `sideEffects` — without those entries rolldown
 * drops the whole import chain from the production bundle.
 */
import.meta.glob("../../plugins/builtin/*/renderer/index.{ts,tsx}", { eager: true });
