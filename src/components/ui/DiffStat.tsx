import { cn } from "@/lib/utils";

interface DiffStatProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  insertions?: number | null;
  deletions?: number | null;
}

/**
 * Line churn in the one spelling the app uses: "+12 -3", added in the success
 * ink, removed in the error ink, ASCII signs, a space between them and no
 * separator. A zero side is left out, and so is the whole stat when both are —
 * "+0 -0" is noise on a row that has nothing to report.
 *
 * The status inks, not the diff gutter colours: the gutter tokens are tuned as
 * line backgrounds and the stat is text sitting beside other text. Size, weight
 * and placement stay with the caller.
 */
export function DiffStat({ insertions, deletions, className, ...rest }: DiffStatProps) {
  const added = insertions ?? 0;
  const removed = deletions ?? 0;
  if (added <= 0 && removed <= 0) return null;
  return (
    <span {...rest} className={cn("inline-flex items-center gap-1 tabular-nums", className)}>
      {added > 0 && <span className="text-status-success">+{added.toLocaleString()}</span>}
      {removed > 0 && <span className="text-status-error">-{removed.toLocaleString()}</span>}
    </span>
  );
}
