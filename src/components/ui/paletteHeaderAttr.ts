/**
 * Marks a palette's header region so the anchored shell (`AppPalettePopover`)
 * can redirect a mousedown on the padding around the search box back into the
 * input. Inert in the modal form, which has no focus-scope wrapper for focus to
 * park on.
 *
 * Its own module rather than an `AppPaletteDialog` export because suites stub
 * that component wholesale: a mock factory that omits the constant would leave
 * the shell matching `[undefined]`, which throws on the first mousedown that
 * reaches it.
 */
export const PALETTE_HEADER_ATTR = "data-palette-header";
