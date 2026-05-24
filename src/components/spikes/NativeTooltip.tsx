import * as React from "react";
import { cn } from "@/lib/utils";

interface NativeTooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<{
    style?: React.CSSProperties;
    onPointerEnter?: React.PointerEventHandler;
    onPointerLeave?: React.PointerEventHandler;
    onFocus?: React.FocusEventHandler;
    onBlur?: React.FocusEventHandler;
  }>;
}

/**
 * Spike: tooltip built on native `[popover="hint"]` + CSS Anchor Positioning.
 *
 * Finding: Chromium 146 has no declarative hover trigger (`interestfor` is
 * still flagged), so show/hide is wired in JS. Once shown, positioning,
 * top-layer stacking, and the fade are entirely CSS — no Floating UI, no
 * Portal. `popover="hint"` auto-dismisses when another hint opens.
 *
 * The popover is looked up by id in the handlers rather than via a ref so the
 * component stays clean under the React Compiler (no ref access in render).
 */
export function NativeTooltip({ content, children }: NativeTooltipProps) {
  const id = React.useId();
  const safeId = id.replace(/[^a-zA-Z0-9]/g, "");
  const popoverId = `np-tt-${safeId}`;
  const anchorName = `--np-tt-${safeId}`;

  // togglePopover(force) is idempotent — bare show/hidePopover throw
  // InvalidStateError when called against an already-open/closed popover
  // (e.g. focus-then-hover, or a hint auto-dismissed by a sibling).
  const toggle = (open: boolean) => {
    document.getElementById(popoverId)?.togglePopover(open);
  };

  const trigger = React.cloneElement(children, {
    style: { ...children.props.style, anchorName },
    onPointerEnter: (e: React.PointerEvent) => {
      children.props.onPointerEnter?.(e);
      toggle(true);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      children.props.onPointerLeave?.(e);
      toggle(false);
    },
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e);
      toggle(true);
    },
    onBlur: (e: React.FocusEvent) => {
      children.props.onBlur?.(e);
      toggle(false);
    },
  });

  return (
    <>
      {trigger}
      <div
        id={popoverId}
        popover="hint"
        role="tooltip"
        style={{ "--np-anchor": anchorName } as React.CSSProperties}
        className={cn(
          "np-surface np-tooltip",
          "max-w-xs rounded-[var(--radius-md)] surface-overlay shadow-overlay px-3 py-1.5 text-xs text-daintree-text"
        )}
      >
        {content}
      </div>
    </>
  );
}
