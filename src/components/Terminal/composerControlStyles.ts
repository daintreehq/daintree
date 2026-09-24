/**
 * Colour for the controls that sit inside the agent composer's shell.
 *
 * The shell is painted from the terminal palette (`resolveInputBarColors`), not
 * the app surface, and a terminal stays dark under a light app theme. The app
 * text ramp is tuned for app surfaces, so on the shell it lands dark-on-dark.
 * These read the shell's own `--ib-fg`/`--ib-bg`, which `HybridInputBar` sets
 * on the shell, so the pair always comes from one palette.
 *
 * Mixing toward `--ib-bg` rather than transparent keeps each a solid colour
 * whose contrast is fixed by the pair, whichever polarity the terminal has.
 * Neutral throughout: these controls repeat in every composer on screen, and
 * the shell's own focus ring already spends the accent.
 */
export const COMPOSER_CONTROL_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--ib-fg)_72%,var(--ib-bg))] hover:text-[var(--ib-fg)] focus-visible:text-[var(--ib-fg)]";

export const COMPOSER_CONTROL_HOVER_BG_CLASS =
  "hover:bg-[color-mix(in_oklab,var(--ib-fg)_8%,transparent)]";

/**
 * Outline only — no colour change — so a control carrying a status colour (the
 * mic in its error state) keeps it under keyboard focus. Inset, so it survives
 * the mic's `contain: strict` wrapper, which clips anything painted outside its
 * 24px box. Drawn on the control itself so a Tab onto one reads as that control
 * and not the editor beside it.
 */
export const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[color-mix(in_oklab,var(--ib-fg)_60%,var(--ib-bg))]";
