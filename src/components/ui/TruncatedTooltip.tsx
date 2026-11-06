import type { Ref } from "react";
import React from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TRUNCATION_DISCLOSURE_ATTR } from "@/lib/accessibility";

const FOCUSABLE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "AUDIO", "VIDEO"]);

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (el: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(el);
      } else if (ref) {
        (ref as React.MutableRefObject<T | null>).current = el;
      }
    }
  };
}

export interface TruncatedTooltipProps {
  children: React.ReactElement;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  contentClassName?: string;
  disabled?: boolean;
  isTruncated?: boolean;
  /**
   * False inside a row that is already the focus target — a button, an option
   * driven by `aria-activedescendant`, a menu item. The row owns the keyboard
   * there, and a tab stop on its text would be a second one; the tooltip is
   * then a pointer disclosure only.
   */
  focusable?: boolean;
  /**
   * Show the full text without hover — for a row the arrow keys are on, where
   * there is no DOM focus to open it. Still only while the text is cut.
   */
  open?: boolean;
  /** Told when a controlled `open` is dismissed (Escape, another tooltip opening). */
  onOpenChange?: (open: boolean) => void;
}

export function TruncatedTooltip({
  children,
  content,
  side,
  align,
  contentClassName,
  disabled,
  isTruncated: isTruncatedProp,
  focusable = true,
  open,
  onOpenChange,
}: TruncatedTooltipProps) {
  const ownDetection = useTruncationDetection();
  const isTruncated = isTruncatedProp ?? ownDetection.isTruncated;
  const showTooltip = isTruncated && !disabled;

  const childType = typeof children.type === "string" ? (children.type as string) : "";
  const isFocusable = FOCUSABLE_TAGS.has(childType.toUpperCase());

  const mergedRef = mergeRefs(
    isTruncatedProp ? undefined : ownDetection.ref,
    // React 19 carries a ref as a prop; reading `element.ref` is deprecated
    // and warns in development.
    (children.props as { ref?: React.Ref<unknown> }).ref
  );

  const extraProps: Record<string, unknown> = { ref: mergedRef };
  if (focusable && !isFocusable && showTooltip) {
    extraProps.tabIndex = 0;
    // A tab stop that only reveals text: a dialog's initial focus passes over
    // it, or opening the dialog would open this tooltip.
    extraProps[TRUNCATION_DISCLOSURE_ATTR] = "";
  }

  return (
    // The tooltip IS the content here (the untruncated text), so it stays as
    // long as the user is reading it — no auto-dismiss.
    <Tooltip open={showTooltip ? open : false} onOpenChange={onOpenChange} autoDismiss={false}>
      <TooltipTrigger asChild>{React.cloneElement(children, extraProps)}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
