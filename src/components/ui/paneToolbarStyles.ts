/**
 * The one in-pane toolbar icon button: file viewer, diff, cross-worktree diff,
 * browser, portal, notification center and the find bars all spell their icon
 * buttons with these, so the same action cannot look or respond differently
 * depending on which pane it sits in.
 *
 * Hover, keyboard focus, the armed chip and the 50% disabled treatment all come
 * from `.toolbar-icon-button` in `src/styles/components/toolbar.css`; this
 * string only fixes the box, the corner and the ink. The radius is Button's
 * `--radius-md` so a toolbar icon button and a `Button` beside it share a
 * corner. Pressed and expanded controls step up to primary ink on top of the
 * armed chip, so the state is carried by two cues rather than one tint.
 */
export const PANE_TOOLBAR_ICON_BUTTON_CLASS =
  "toolbar-icon-button inline-flex shrink-0 items-center justify-center p-1.5 rounded-[var(--radius-md)] text-text-secondary aria-pressed:text-text-primary aria-expanded:text-text-primary";

/**
 * 14px rather than 16: at 16 the glyphs read heavier than the text beside them
 * and Refresh in particular dominated a row it only shares. With the button's
 * `p-1.5` this still leaves a 26px target, above the 24px WCAG 2.5.8 floor.
 */
export const PANE_TOOLBAR_ICON_CLASS = "h-3.5 w-3.5";

/**
 * The same control carrying a word (Viewed, Send notes, Mark all read, Reset).
 * `h-6.5` holds it to the icon button's 26px so a row mixing the two keeps one
 * height, and every state is the icon button's.
 */
export const PANE_TOOLBAR_TEXT_BUTTON_CLASS =
  "toolbar-icon-button inline-flex h-6.5 shrink-0 items-center gap-1.5 px-2 rounded-[var(--radius-md)] text-xs text-text-secondary whitespace-nowrap aria-pressed:text-text-primary aria-expanded:text-text-primary";

/**
 * The status strip along the bottom of a pane or side panel: what the view is
 * showing (hidden dotfiles, image size and zoom, scratchpad lifecycle, the
 * assistant's tool activity) and at most a control or two beside it. It is the
 * compact `SurfaceHeader`'s counterpart on the other edge — the same 12px inset
 * and the same `border-divider` separator — so a pane's top and bottom chrome
 * read as one frame. `min-h-6` rather than `h-6` lets a strip that wraps (the
 * image footer at narrow widths) grow instead of clipping.
 *
 * A strip whose items carry their own hover chip (`px-1.5`) insets by that much
 * less (`px-1.5`), so the ink still lands on the 12px line.
 */
export const PANE_STATUS_FOOTER_CLASS =
  "flex min-h-6 shrink-0 items-center gap-2 border-t border-divider px-3 py-1 text-2xs text-text-secondary";
