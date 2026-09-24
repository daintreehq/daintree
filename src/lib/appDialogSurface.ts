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
 * owns the Escape keypress (it closes, or while locked swallows it), and is
 * absent once the dialog is closing. This one only asks "is this an app
 * dialog".
 */
export const APP_DIALOG_SURFACE_ATTR = "data-app-dialog-surface";
