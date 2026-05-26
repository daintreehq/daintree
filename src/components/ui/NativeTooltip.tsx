import * as React from "react";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type TriggerProps = React.HTMLAttributes<HTMLElement>;

type NativeTooltipProps = {
  content: React.ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  delay?: number;
  className?: string;
  contentClassName?: string;
  children: React.ReactElement<TriggerProps>;
};

const POSITION_AREA: Record<Side, Record<Align, string>> = {
  top: { start: "top span-right", center: "top", end: "top span-left" },
  bottom: { start: "bottom span-right", center: "bottom", end: "bottom span-left" },
  left: { start: "left span-bottom", center: "left", end: "left span-top" },
  right: { start: "right span-bottom", center: "right", end: "right span-top" },
};

const TRANSFORM_ORIGIN: Record<Side, string> = {
  top: "center bottom",
  bottom: "center top",
  left: "right center",
  right: "left center",
};

// Per-instance show-delay timers keyed by popoverId. Module scope (rather than
// useRef) keeps ref reads out of the cloneElement-passed handler closures —
// the React Compiler can't classify those as event handlers and would flag
// `ref.current` access as a render-phase read (see spike commit 0319cab22).
const showTimers = new Map<string, number>();

function sanitizeAnchorId(id: string): string {
  return `--np-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function NativeTooltip({
  content,
  side = "top",
  align = "center",
  sideOffset = 4,
  delay = 200,
  className,
  contentClassName,
  children,
}: NativeTooltipProps) {
  const reactId = React.useId();
  const anchorName = sanitizeAnchorId(reactId);
  const popoverId = `np-tt-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  React.useEffect(
    () => () => {
      const pending = showTimers.get(popoverId);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        showTimers.delete(popoverId);
      }
    },
    [popoverId]
  );

  function show() {
    const pending = showTimers.get(popoverId);
    if (pending !== undefined) window.clearTimeout(pending);
    const timer = window.setTimeout(() => {
      showTimers.delete(popoverId);
      // togglePopover(force) is idempotent — bare showPopover throws
      // InvalidStateError when called on an already-open popover.
      document.getElementById(popoverId)?.togglePopover(true);
    }, delay);
    showTimers.set(popoverId, timer);
  }

  function hide() {
    const pending = showTimers.get(popoverId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      showTimers.delete(popoverId);
    }
    document.getElementById(popoverId)?.togglePopover(false);
  }

  const childProps = children.props;

  // The consumer-provided `style` is spread last so an explicit
  // `anchorName` on a child trigger wins — surprising, but matches normal
  // React style-merge precedence and keeps the POC predictable.
  const triggerStyle: React.CSSProperties = {
    anchorName,
    ...childProps.style,
  };

  const triggerOverrides: TriggerProps = {
    "aria-describedby": popoverId,
    style: triggerStyle,
    className: cn(childProps.className, className),
    onPointerEnter: (event) => {
      show();
      childProps.onPointerEnter?.(event);
    },
    onPointerLeave: (event) => {
      hide();
      childProps.onPointerLeave?.(event);
    },
    onFocus: (event) => {
      show();
      childProps.onFocus?.(event);
    },
    onBlur: (event) => {
      hide();
      childProps.onBlur?.(event);
    },
  };

  // csstype's Properties type rejects `--*` keys in object literals — the
  // cast is the documented codebase pattern (see ContentPanel.tsx,
  // SortableTabButton.tsx, DemoOverlay.tsx).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const popoverStyle = {
    "--np-anchor": anchorName,
    "--np-position-area": POSITION_AREA[side][align],
    "--np-transform-origin": TRANSFORM_ORIGIN[side],
    "--np-side-offset": `${sideOffset}px`,
  } as React.CSSProperties;

  return (
    <>
      {React.cloneElement(children, triggerOverrides)}
      <div
        id={popoverId}
        popover="hint"
        role="tooltip"
        style={popoverStyle}
        className={cn(
          "native-popover-spike native-popover-spike-tooltip surface-overlay shadow-overlay",
          contentClassName
        )}
      >
        {content}
      </div>
    </>
  );
}
