import { GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "./badge";

/**
 * A branch or ref named inside a surface's chrome. Mono, like every other place
 * a branch is drawn, and never uppercased: refs are case-sensitive.
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
      className={cn("min-w-0 max-w-[200px] font-mono", className)}
    >
      <GitBranch aria-hidden="true" />
      <span className="truncate">{branch}</span>
    </Badge>
  );
}
