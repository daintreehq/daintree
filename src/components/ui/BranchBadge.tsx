import { GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { TruncatedTooltip } from "./TruncatedTooltip";

/**
 * A branch named inside a surface's chrome. Mono, like every other place a
 * branch is drawn, and never uppercased: refs are case-sensitive.
 *
 * It owns its tooltip because the text truncates on the inner span, which is
 * the only element whose overflow says whether the full name is hidden.
 */
export function BranchBadge({
  branch,
  className,
  "data-testid": testId,
}: {
  branch: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Badge
      size="sm"
      tone="outline"
      data-testid={testId}
      className={cn("min-w-0 max-w-[200px] shrink font-mono", className)}
    >
      <GitBranch aria-hidden="true" />
      <TruncatedTooltip content={branch}>
        <span className="truncate">{branch}</span>
      </TruncatedTooltip>
    </Badge>
  );
}
