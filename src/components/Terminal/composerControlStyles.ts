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
 * How much foreground goes in is `--ib-control-mix`, fitted per palette to 3:1
 * (`resolveInputBarColors`): a fixed 72% left Solarized Light's paperclip at
 * 2.6:1. Neutral throughout: these controls repeat in every composer on
 * screen, and the shell's own focus ring already spends the accent.
 */
export const COMPOSER_CONTROL_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--ib-fg)_var(--ib-control-mix,72%),var(--ib-bg))] hover:text-[var(--ib-fg)] focus-visible:text-[var(--ib-fg)]";

/**
 * The `❯` marker sits at the head of the line being typed, so it is what says
 * which composer is the selected one: `--ib-marker` steps up on the selected
 * composer and stays at the control ink everywhere else. It takes no focus
 * recipe: it is never in the Tab order.
 */
export const COMPOSER_MARKER_TEXT_CLASS = "text-[var(--ib-marker)]";

/**
 * Hover for the `❯` where a click on it opens prompt history: the ink steps up
 * to the shell's foreground and a wash, the controls' own hover tint, is drawn
 * by a pseudo-element just outside the glyph. Nothing here sizes the marker, so
 * it keeps the glyph's width and the draft beside it keeps every pixel. The
 * selected composer's marker can already sit at the foreground ink, so the wash
 * is what says it is clickable there.
 */
export const COMPOSER_MARKER_HOVER_CLASS =
  "relative cursor-pointer transition-colors hover:text-[var(--ib-fg)] before:pointer-events-none before:absolute before:-inset-x-1 before:inset-y-0.5 before:rounded-sm hover:before:bg-[color-mix(in_oklab,var(--ib-fg)_8%,transparent)]";

export const COMPOSER_CONTROL_HOVER_BG_CLASS =
  "hover:bg-[color-mix(in_oklab,var(--ib-fg)_8%,transparent)]";

/**
 * Outline only — no colour change — so a control carrying a status colour (the
 * mic in its error state) keeps it under keyboard focus. Inset, because the
 * trailing controls sit edge to edge and an outward ring would paint over the
 * neighbour. Drawn on the control itself so a Tab onto one reads as that
 * control and not the editor beside it. The same fitted mix as the control
 * ink, so the ring clears 3:1 wherever the glyph does.
 */
export const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_oklab,var(--ib-fg)_var(--ib-control-mix,72%),var(--ib-bg))]";
