/**
 * Marks an `AppDialog`'s outermost node (its backdrop, which contains the
 * panel).
 *
 * Read by `handleDockInteractOutside`: a dock popover renders in its own Radix
 * layer, and a dialog opened from inside it portals to the body, so every click
 * in that dialog is an "outside" interaction as far as the popover is
 * concerned. The popover has to stay open behind the dialog it spawned
 * (#11505) — the Escape path already guards that, and this is the pointer path.
 *
 * Separate from `ESCAPE_BACKSTOP_DIALOG_ATTR`: that one tracks whether a dialog
 * will *take* an Escape keypress, so it is absent on a non-dismissible dialog.
 * This one only asks "is this an app dialog", which is true either way.
 */
export const APP_DIALOG_SURFACE_ATTR = "data-app-dialog-surface";
