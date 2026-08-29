import type { HiddenRowCounts } from "./fileBrowserTree";

export interface FileBrowserHiddenStripProps {
  counts: HiddenRowCounts;
  /** Turns the dotfile filter off. The only recovery this strip can offer. */
  onShowDotfiles: () => void;
}

/**
 * Says, in words, what the view is currently removing — and offers the one
 * gesture that puts it back.
 *
 * This is the answer to the hidden-file trap: a filter left on, come back
 * later, and the rows that are simply absent read as files someone deleted.
 * A lit icon never said that. It said only that a setting was on, in a chip
 * measured at 1.53:1 against the header, using the divider's own colour.
 *
 * CONDITIONAL, and that is the whole design. A permanent pane-level status bar
 * is the documented anti-pattern for a file tree — VS Code, JetBrains, Zed,
 * Sublime and Nautilus all ship none, because vertical height is the scarce
 * resource in a sidebar and a static item count does not earn a row of it.
 * This strip exists only while the dotfile filter is actually removing
 * something, so at rest it costs nothing at all.
 *
 * Counts only what the toggle can reveal. Entries the app-global junk list
 * hides — `.git`, `.DS_Store` and friends — are excluded deliberately: they are
 * hidden by design and permanently, so including them would leave this strip
 * on screen forever in every git repo, which is precisely the permanent status
 * bar the paragraph above rejects. It would also offer "Show dotfiles" as a
 * recovery for rows that gesture cannot reveal.
 *
 * BELOW the tree, never above. The strip mounts and unmounts as the filter
 * changes, and above the rows that would shift them mid-gesture — the second
 * click of a double-click landing one row off. Same rule the Reveal strip
 * follows, and the same tokens.
 */
export function FileBrowserHiddenStrip({ counts, onShowDotfiles }: FileBrowserHiddenStripProps) {
  if (counts.dotfiles <= 0) return null;

  return (
    <div
      // `status`, not `contentinfo`: this is a live region reporting what the
      // view is doing, and `contentinfo` is reserved for a page-level footer.
      role="status"
      data-testid="file-browser-hidden-strip"
      className="flex shrink-0 items-center gap-2 border-t border-border-default px-3 py-1 text-2xs text-text-secondary"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="tabular-nums">{counts.dotfiles}</span>
        {counts.dotfiles === 1 ? " dotfile hidden" : " dotfiles hidden"}
      </span>
      {/* Verb-first and specific, so the button says what will happen rather
          than "Undo" or "Clear". Sentence case, no period, per the microcopy
          rule for buttons. */}
      <button
        type="button"
        onClick={onShowDotfiles}
        className="shrink-0 rounded-lg px-1 text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
      >
        Show
      </button>
    </div>
  );
}
