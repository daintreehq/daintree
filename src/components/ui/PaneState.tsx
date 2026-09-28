import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";

/**
 * The pane-filling frame every non-content state of a pane shares — no URL,
 * not configured, load failed. Scrolls rather than clips in a short pane, and
 * keeps the title and description in one live region so a change of state is
 * announced without the actions being read out again.
 *
 * `live="alert"` is for a load that failed under the user; everything else is
 * a polite status.
 */
export function PaneState({
  icon,
  title,
  description,
  children,
  live = "status",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  live?: "status" | "alert";
  className?: string;
}) {
  return (
    <div className={cn("absolute inset-0 overflow-y-auto bg-surface-canvas", className)}>
      <div className="flex min-h-full flex-col items-center justify-center gap-5 p-6">
        <div role={live} aria-live={live === "status" ? "polite" : undefined} className="w-full">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={icon}
            title={title}
            description={description}
            className="p-0"
          />
        </div>
        {children}
      </div>
    </div>
  );
}

/** A pane's action row under a `PaneState`. */
export function PaneStateActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>;
}

/**
 * What a pane shows while its content is deliberately not mounted — not yet
 * viewed, or evicted to save memory. One quiet line: nothing is wrong and
 * nothing is asked of the user; the content comes back by itself.
 */
export function PanePlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface-canvas p-6">
      <p className="max-w-sm text-center text-sm text-text-secondary text-balance">{children}</p>
    </div>
  );
}
