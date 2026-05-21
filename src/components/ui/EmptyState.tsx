import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateCommonProps = {
  title: string;
  className?: string;
};

export type EmptyStateScale = "popover" | "sidebar" | "canvas";

export type EmptyStateProps =
  | (EmptyStateCommonProps & {
      variant: "zero-data";
      scale: "popover" | "sidebar";
      icon?: ReactNode;
      description?: never;
      action?: ReactNode;
      instant?: boolean;
    })
  | (EmptyStateCommonProps & {
      variant: "zero-data";
      scale: "canvas";
      icon?: ReactNode;
      description?: ReactNode;
      action?: ReactNode;
      instant?: boolean;
    })
  | (EmptyStateCommonProps & {
      variant: "filtered-empty";
      scale: "popover" | "sidebar";
      description?: never;
      action?: ReactNode;
      instant?: boolean;
    })
  | (EmptyStateCommonProps & {
      variant: "filtered-empty";
      scale: "canvas";
      description?: ReactNode;
      action?: ReactNode;
      instant?: boolean;
    })
  /**
   * Completed-result "Blank Slate" — the user intentionally reached this state
   * (cleared queue, inbox zero, dismissed all notifications). Atlassian's
   * distinction: a Blank Slate celebrates a finished task and stays quiet,
   * while an Empty State invites action. Recovery for completed-result states
   * lives in global undo surfaces (snackbar, Trash) — adding a per-instance
   * recovery action implies the user made a mistake and creates cognitive
   * friction. The title alone conveys completion (canonical example:
   * NotificationCenter "You're all caught up"), so `description` and `action`
   * are forbidden by design. `instant` is irrelevant: completed-result states
   * are reached deliberately, not by rapid keystroke flips.
   */
  | (EmptyStateCommonProps & {
      variant: "user-cleared";
      scale: "popover" | "sidebar" | "canvas";
      icon?: ReactNode;
      description?: never;
      action?: never;
      instant?: never;
    });

const EXIT_SAFETY_MS = 250;

function renderInner(
  props: EmptyStateProps,
  descriptionId: string,
  hasDescription: boolean,
  rawDescription: ReactNode
) {
  const icon = props.variant === "filtered-empty" ? null : props.icon;
  const action = props.variant === "user-cleared" ? null : props.action;
  return (
    <>
      {icon ? (
        <div
          className="text-daintree-text/30 [&_svg]:h-6 [&_svg]:w-6 @max-[280px]/empty-state:[&_svg]:h-4 @max-[280px]/empty-state:[&_svg]:w-4"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-daintree-text/70">{props.title}</p>
      {hasDescription ? (
        <p id={descriptionId} className="text-xs text-daintree-text/50 max-w-xs">
          {rawDescription}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </>
  );
}

function getRawDescription(props: EmptyStateProps): ReactNode {
  if (props.variant === "user-cleared") return undefined;
  return "description" in props ? props.description : undefined;
}

function getTransitionKey(props: EmptyStateProps): string {
  const desc = getRawDescription(props);
  // Stringify only string/number descriptions for the key; JSX descriptions
  // serialize to "[object Object]" which would collapse distinct nodes into
  // the same key. For JSX descriptions, fall back to a sentinel — the
  // transition will fire on any other prop change (title, variant, scale)
  // and JSX-description-only swaps are an edge case at canvas scale.
  let descKey = "";
  if (typeof desc === "string" || typeof desc === "number") {
    descKey = String(desc);
  } else if (desc !== undefined && desc !== null && desc !== false) {
    descKey = "[node]";
  }
  return `${props.variant}|${props.scale}|${props.title}|${descKey}`;
}

export function EmptyState(props: EmptyStateProps) {
  const { className } = props;
  const instant = "instant" in props ? props.instant === true : false;

  const descriptionId = useId();
  const rawDescription = getRawDescription(props);
  const hasDescription =
    rawDescription !== undefined &&
    rawDescription !== null &&
    rawDescription !== false &&
    rawDescription !== "";

  // Fade Through state machine — follows AnimatedLabel: a generation counter
  // remounts the cells on every change so rapid flips restart the animation
  // even when a new transition arrives inside the previous one's window.
  const transitionKey = getTransitionKey(props);
  const prevKeyRef = useRef(transitionKey);
  const prevPropsRef = useRef<EmptyStateProps>(props);
  const [generation, setGeneration] = useState(0);
  const [outgoing, setOutgoing] = useState<EmptyStateProps | null>(null);

  useEffect(() => {
    if (prevKeyRef.current === transitionKey) {
      prevPropsRef.current = props;
      return;
    }
    if (!instant) {
      setOutgoing(prevPropsRef.current);
      setGeneration((g) => g + 1);
    } else {
      setOutgoing(null);
    }
    prevKeyRef.current = transitionKey;
    prevPropsRef.current = props;
  }, [transitionKey, instant, props]);

  // Safety cleanup — under reduced-motion / performance-mode the CSS animation
  // is suppressed entirely, so `animationend` never fires from the outgoing
  // cell. Without this timeout the previous content latches in the DOM.
  useEffect(() => {
    if (outgoing === null) return;
    const timer = setTimeout(() => setOutgoing(null), EXIT_SAFETY_MS);
    return () => clearTimeout(timer);
  }, [outgoing, generation]);

  const isAnimating = outgoing !== null;
  const handleExitEnd = () => setOutgoing(null);

  const outgoingDescription = outgoing ? getRawDescription(outgoing) : undefined;
  const outgoingHasDescription =
    outgoingDescription !== undefined &&
    outgoingDescription !== null &&
    outgoingDescription !== false &&
    outgoingDescription !== "";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-describedby={hasDescription ? descriptionId : undefined}
      className={cn(
        "@container/empty-state flex flex-col items-center justify-center text-center px-4 py-8",
        className
      )}
    >
      <div className="grid">
        <div
          key={`current-${generation}`}
          className="[grid-area:1/1] flex flex-col items-center gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        >
          {renderInner(props, descriptionId, hasDescription, rawDescription)}
        </div>
        {isAnimating && outgoing ? (
          <div
            key={`prev-${generation}`}
            aria-hidden="true"
            // `inert` removes the outgoing subtree from the tab order *and*
            // the accessibility tree so the stale `action` button (e.g.,
            // "Clear search") can't take focus during the 100–250ms exit.
            // `aria-hidden` alone leaves it focusable via keyboard.
            inert
            className="[grid-area:1/1] flex flex-col items-center gap-2 pointer-events-none motion-safe:animate-out motion-safe:fade-out motion-safe:duration-[100ms]"
            onAnimationEnd={handleExitEnd}
          >
            {renderInner(
              outgoing,
              `${descriptionId}-out`,
              outgoingHasDescription,
              outgoingDescription
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
