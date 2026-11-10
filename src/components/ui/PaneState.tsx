import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useLiveRegionReady } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import type { RootAttributes } from "@/components/ui/rootAttributes";

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
  announceAfterMount = false,
  inFlow = false,
  className,
  rootAttributes,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /**
   * `off` keeps the status role but doesn't announce changes: for a state
   * whose changes the window already says once (who has control of the
   * project), so N panes don't each say it again.
   */
  live?: "status" | "alert" | "off";
  /**
   * For a polite state that appears under the user mid-session, such as a load
   * they stopped: a region that mounts with its message already inside is often
   * never spoken (ARIA22), so it registers empty and the words land a commit
   * later. Off by default, so panes restored at launch don't all speak at once.
   */
  announceAfterMount?: boolean;
  /**
   * Take up room in the layout instead of covering the pane — for a host that
   * sizes to its content, such as a dialog, where an overlay has no height.
   */
  inFlow?: boolean;
  className?: string;
  /** `id`, `data-*` or `aria-*` on the root; the component's own attributes win. */
  rootAttributes?: RootAttributes;
}) {
  const deferred = announceAfterMount && live === "status";
  const emptyState = (
    <EmptyState
      variant="zero-data"
      scale="canvas"
      icon={icon}
      title={title}
      description={description}
      className="p-0"
    />
  );

  return (
    <div
      {...rootAttributes}
      className={cn(
        inFlow ? "relative w-full" : "absolute inset-0",
        "overflow-y-auto bg-surface-canvas",
        className
      )}
    >
      <div className="flex min-h-full flex-col items-center justify-center gap-5 p-6">
        <div
          role={live === "alert" ? "alert" : "status"}
          aria-live={live === "status" ? "polite" : live === "off" ? "off" : undefined}
          className="w-full"
        >
          {deferred ? (
            <>
              <DeferredAnnouncement
                text={typeof description === "string" ? `${title}. ${description}` : title}
              />
              <div aria-hidden="true">{emptyState}</div>
            </>
          ) : (
            emptyState
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The words of a deferred `PaneState`, inserted once its region is registered. */
function DeferredAnnouncement({ text }: { text: string }) {
  const ready = useLiveRegionReady();
  return <span className="sr-only">{ready ? text : ""}</span>;
}

/**
 * A pane-state description whose `backticked` spans are commands, drawn as code
 * rather than as literal backticks.
 */
export function withInlineCode(text: string): ReactNode {
  const parts = text.split(/`([^`]+)`/);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono">
        {part}
      </code>
    ) : (
      part
    )
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
