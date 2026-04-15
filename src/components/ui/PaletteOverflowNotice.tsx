interface PaletteOverflowNoticeProps {
  shown: number;
  total: number;
}

export function PaletteOverflowNotice({ shown, total }: PaletteOverflowNoticeProps) {
  if (total <= shown) return null;

  return (
    <div
      aria-hidden="true"
      className="px-3 py-2 text-xs tabular-nums text-daintree-text/40 text-center border-t border-daintree-border/30"
    >
      Showing {shown} of {total} — refine your search to see more
    </div>
  );
}
