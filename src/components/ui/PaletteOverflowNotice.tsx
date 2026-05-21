interface PaletteOverflowNoticeProps {
  shown: number;
  total: number;
}

export function PaletteOverflowNotice({ shown, total }: PaletteOverflowNoticeProps) {
  if (total <= shown) return null;

  const hidden = total - shown;
  return (
    <div
      role="status"
      aria-label={`${hidden} more results not shown — refine your search to see them`}
      className="px-3 py-2 text-xs tabular-nums text-daintree-text/40 text-center border-t border-daintree-border/30"
    >
      +{hidden} more
    </div>
  );
}
