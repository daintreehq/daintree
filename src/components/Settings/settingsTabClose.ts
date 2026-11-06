/**
 * How a tab registered with `needsOnClose` closes the dialog: unsaved settings
 * are flushed first, and a close they hold answers false and runs nothing.
 * `afterClose(true)` runs once the dialog has gone and handed focus back, so
 * whatever it opens (a terminal, say) can take focus; `afterClose(false)` runs
 * instead when the dialog opens again before that close finished.
 */
export type SettingsTabClose = (afterClose?: (closed: boolean) => void) => Promise<boolean>;
