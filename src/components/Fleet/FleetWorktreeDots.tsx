import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { FleetWorktreeScope } from "./useFleetWorktreeScope";

// Each dot after the first gives up a crescent where the one in front of it
// sits: a circle 1.5px wider than that dot, centred on it (10px dots overlapping
// by 4px put its centre 1px left of this dot's edge). A mask, not a ring: the
// chip's fill is translucent over the ribbon and strengthens on hover and open,
// so no ring colour matches it, whereas a mask shows whatever is behind. It
// also survives forced colors, which drop box-shadow rings outright while
// `status-mark` repaints the dots themselves.
const CUTOUT = "[mask-image:radial-gradient(circle_at_-1px_50%,transparent_6.5px,black_7px)]";

export function FleetWorktreeDots({ scope }: { scope: FleetWorktreeScope }): ReactElement | null {
  if (scope.colors.length === 0) return null;

  // Cap at 3 — the dots are a glance signal, not an inventory. The chip's
  // aria-label already carries the precise worktree count.
  const shown = scope.colors.slice(0, 3);

  return (
    <span
      className="flex items-center -space-x-1"
      aria-hidden="true"
      data-testid="fleet-worktree-dots"
    >
      {shown.map((color, i) => (
        <span
          key={color}
          className={cn("status-mark h-2.5 w-2.5 rounded-full", i > 0 && CUTOUT)}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}
