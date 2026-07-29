/**
 * How far an update install attempt got, in ASCENDING order of specificity —
 * a later entry may overwrite an earlier one, never the reverse.
 *
 * `attempted` is the floor and the one that matters most: it means we handed
 * off to the installer and never learned the outcome. Most install paths end
 * there, because electron-updater's own `autoInstallOnAppQuit` never reaches
 * our handoff and the process usually dies before any error is reported.
 * `handoff-timeout` is the macOS "Restart to update" case — the graceful
 * shutdown chain disposes AutoUpdaterService (detaching its `error` listener)
 * before the handoff runs, so a Squirrel rejection has nothing left listening
 * and only the force-exit watchdog observes it.
 *
 * Deliberately its own module with NO imports. It is persisted by `store.ts`
 * and read by `AutoUpdaterService`, and the service's tests mock `store.js` —
 * a partial mock factory shadows every other export, and reaching for
 * `importOriginal()` to get this list back would load the real `store.ts`,
 * which eagerly imports `electron` and throws wherever the Electron binary
 * isn't installed. Keeping the list side-effect-free lets both the production
 * code and the tests import the single source of truth directly (#11481).
 */
export const PENDING_UPDATE_INSTALL_STAGES = [
  "attempted",
  "handoff-timeout",
  "updater-error",
  "handoff-threw",
] as const;

export type PendingUpdateInstallStage = (typeof PENDING_UPDATE_INSTALL_STAGES)[number];
