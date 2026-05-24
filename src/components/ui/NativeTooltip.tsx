import * as React from "react";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type AnchorPositionStyle = React.CSSProperties & {
  anchorName?: string;
};

type NativeTooltipProps = {
  content: React.ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  delay?: number;
  className?: string;
  contentClassName?: string;
  children: React.ReactElement;
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

  const clearShowTimer = React.useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const show = React.useCallback(() => {
    clearShowTimer();
    showTimerRef.current = window.setTimeout(() => {
      popoverRef.current?.showPopover();
    }, delay);
  }, [clearShowTimer, delay]);

  const hide = React.useCallback(() => {
    clearShowTimer();
    popoverRef.current?.hidePopover();
  }, [clearShowTimer]);

  React.useEffect(() => clearShowTimer, [clearShowTimer]);

  const triggerStyle: AnchorPositionStyle = {
    anchorName,
    ...(children.props as { style?: React.CSSProperties }).style,
  };

  const trigger = React.cloneElement(children, {
    "aria-describedby": popoverId,
    style: triggerStyle,
    className: cn((children.props as { className?: string }).className, className),
    onPointerEnter: (event: React.PointerEvent) => {
      show();
      (children.props as { onPointerEnter?: (e: React.PointerEvent) => void }).onPointerEnter?.(
        event
      );
    },
    onPointerLeave: (event: React.PointerEvent) => {
      hide();
      (children.props as { onPointerLeave?: (e: React.PointerEvent) => void }).onPointerLeave?.(
        event
      );
    },
    onFocus: (event: React.FocusEvent) => {
      show();
      (children.props as { onFocus?: (e: React.FocusEvent) => void }).onFocus?.(event);
    },
    onBlur: (event: React.FocusEvent) => {
      hide();
      (children.props as { onBlur?: (e: React.FocusEvent) => void }).onBlur?.(event);
    },
  } as React.HTMLAttributes<HTMLElement>);

  const popoverStyle = {
    "--np-anchor": anchorName,
    "--np-position-area": POSITION_AREA[side][align],
    "--np-transform-origin": TRANSFORM_ORIGIN[side],
    "--np-side-offset": `${sideOffset}px`,
  } as React.CSSProperties;

  return (
    <>
      {trigger}
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
