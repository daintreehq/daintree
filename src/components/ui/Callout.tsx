import * as React from "react";
import { cva } from "class-variance-authority";
import { AlertTriangle, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A static error or warning box inside a dialog, settings page or card: the
 * in-flow sibling of `InlineStatusBanner`, for messages that sit among the
 * content rather than across the top of a pane.
 *
 * - `error` — something failed. `XCircle`, the glyph `InlineStatusBanner` and
 *   the notification inbox use for the same severity.
 * - `warning` — something needs attention before it goes wrong. `AlertTriangle`.
 * - `danger` — a caution about a destructive or irreversible consequence. It
 *   warns rather than reports a failure, so it keeps the triangle, in danger ink.
 *
 * The glyph and the tint carry the severity; the words stay on the neutral ramp,
 * because status-coloured text has no contrast floor across the themes.
 */

export type CalloutSeverity = "error" | "warning" | "danger";

export const CALLOUT_ICON: Record<CalloutSeverity, typeof XCircle> = {
  error: XCircle,
  warning: AlertTriangle,
  danger: AlertTriangle,
};

const calloutVariants = cva("flex items-start rounded-[var(--radius-md)] border", {
  variants: {
    severity: {
      error: "border-status-error/20 bg-status-error/10",
      warning: "border-status-warning/20 bg-status-warning/10",
      danger: "border-status-danger/20 bg-status-danger/10",
    },
    size: {
      default: "gap-2 px-3 py-2 text-xs",
      // Dense surfaces whose own copy is already `text-2xs` — plugin rows and cards.
      compact: "gap-2 px-2.5 py-2 text-2xs",
    },
  },
  defaultVariants: { severity: "error", size: "default" },
});

const ICON_TONE: Record<CalloutSeverity, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  danger: "text-status-danger",
};

// Centred on the first line: 16px on a 16px `text-xs` line, 14px on `text-2xs`.
const ICON_SIZE = {
  default: "w-4 h-4",
  compact: "w-3.5 h-3.5 mt-px",
} as const;

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  severity: CalloutSeverity;
  ref?: React.Ref<HTMLDivElement>;
  size?: "default" | "compact";
  /** A short headline. The body under it steps down to secondary text. */
  title?: React.ReactNode;
  /** One trailing control beside the message — a Retry. Anything more goes in the body. */
  action?: React.ReactNode;
}

export function Callout({
  severity,
  size = "default",
  title,
  action,
  className,
  children,
  ...props
}: CalloutProps) {
  const Icon = CALLOUT_ICON[severity];
  return (
    <div
      {...props}
      data-callout={severity}
      className={cn(calloutVariants({ severity, size }), className)}
    >
      <Icon className={cn(ICON_SIZE[size], "shrink-0", ICON_TONE[severity])} aria-hidden="true" />
      <div
        className={cn(
          "min-w-0 flex-1 break-words",
          title ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {title && <p className="mb-0.5 font-medium text-text-primary">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
