// eslint-disable-next-line react-compiler/react-compiler
"use no memo";

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
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const showTimerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    },
    []
  );

  function show() {
    if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    showTimerRef.current = window.setTimeout(() => {
      popoverRef.current?.showPopover();
    }, delay);
  }

  function hide() {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    popoverRef.current?.hidePopover();
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
        ref={popoverRef}
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
