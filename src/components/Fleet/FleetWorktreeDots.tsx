import type { ReactElement } from "react";
import type { FleetWorktreeScope } from "./useFleetWorktreeScope";

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
          className="h-2.5 w-2.5 rounded-full ring-2 ring-[var(--theme-surface-canvas)]"
          style={{ backgroundColor: color, zIndex: shown.length - i }}
        />
      ))}
    </span>
  );
}
