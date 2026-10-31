/**
 * Where you are, in words, at the trailing edge of a navigation palette's row.
 *
 * A trailing check read as "done" among rows that carry agent status, and the
 * check is this app's mark for a chosen value in a picker; switching is
 * navigation, so the row says "Current". Hidden from readers because every row
 * that draws it carries the fact in its accessible name and `aria-current`.
 * Shared so the project, worktree and quick switchers say it the same way.
 */
export function PaletteCurrentLabel() {
  return (
    <span aria-hidden="true" className="shrink-0 text-xs text-text-secondary">
      Current
    </span>
  );
}
