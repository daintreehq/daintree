interface PaletteOverflowNoticeProps {
  shown: number;
  total: number;
}

/**
 * The tail a capped palette search didn't rank. Unlike the app's other overflow
 * counts this one has no list to open: the hidden rows are the matches that
 * scored below the cut, and the route to them is the search field that's
 * already focused. So the recovery goes in the visible copy rather than behind
 * a disclosure — a control here would either re-rank the same query or open a
 * second focus domain inside a palette that owns the arrow keys (#12001).
 */
export function PaletteOverflowNotice({ shown, total }: PaletteOverflowNoticeProps) {
  if (total <= shown) return null;

  const hidden = total - shown;
  return (
    <div
      role="status"
      aria-label={`${hidden} more results not shown — type to narrow your search`}
      className="px-3 py-2 text-xs tabular-nums text-text-secondary text-center border-t border-daintree-border/30"
    >
      +{hidden} more — type to narrow
    </div>
  );
}
