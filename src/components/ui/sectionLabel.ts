/**
 * The two small uppercase labels the app draws, one per role. Every eyebrow in
 * the app is one of these; a local copy of either is how the ten variants this
 * replaced came about.
 *
 * Author the text in sentence case and let `uppercase` do the rest — screen
 * readers spell out words that arrive already in capitals. Keep the text to a
 * word or two of app vocabulary: never a branch, a path, or anything else the
 * user typed, because uppercasing a case-sensitive name misstates it.
 *
 * Settings is the exception by design: its sections and groups are sentence
 * case (`SettingsSection`, `SettingsGroup`), and these labels do not belong on
 * a settings page.
 */

/**
 * Names a section of a dialog, pane, page or card body: "Commands", "Source",
 * "Worktrees to remove".
 */
export const SECTION_LABEL_CLASS =
  "text-2xs font-semibold uppercase tracking-wider text-text-secondary";

/**
 * Names a band of rows inside a list — a palette, menu, popover list or the
 * sidebar — and captions a field inside a dense row. One size smaller than
 * {@link SECTION_LABEL_CLASS} because the rows under it are themselves small;
 * see `PALETTE_SECTION_LABEL_CLASS`, which is this recipe.
 *
 * `text-text-secondary`, never a muted tone: at 10px this is ordinary small
 * text under WCAG 1.4.3 and owes 4.5:1.
 */
export const LIST_LABEL_CLASS =
  "text-3xs font-medium uppercase tracking-wider text-text-secondary select-none";
