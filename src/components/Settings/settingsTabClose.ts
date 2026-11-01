/**
 * How a tab registered with `needsOnClose` closes the dialog: unsaved settings
 * are flushed first, and a close they hold answers false and runs nothing.
 * `afterClose` runs once the dialog has gone and handed focus back, so whatever
 * it opens (a terminal, say) can take focus.
 */
export type SettingsTabClose = (afterClose?: () => void) => Promise<boolean>;
