import * as React from "react";
import { cva } from "class-variance-authority";
import { OctagonAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";

/**
 * A static message box inside a dialog, settings page or card: the in-flow
 * sibling of `InlineStatusBanner`, for messages that sit among the content
 * rather than across the top of a pane.
 *
 * - `error` — something failed. `XCircle`.
 * - `warning` — something needs attention before it goes wrong. `AlertTriangle`.
 * - `danger` — a caution about a destructive or irreversible consequence. It
 *   warns rather than reports a failure, so it is not the error's `XCircle`;
 *   it is `OctagonAlert`, the one caution glyph that does not share the
 *   warning's triangle, so the two stay apart under forced colours.
 * - `success` — something finished and the user can carry on. `CheckCircle2`.
 * - `info` — something worth knowing that asks nothing. `Info`.
 * - `neutral` — a state to note, with no severity at all: the neutral ramp, no
 *   status tint. Its glyph defaults to `Info`, and it is the one tone that may
 *   take a domain glyph through `icon` (a key for a sign-in state).
 *
 * error, warning, success and info are `SEVERITY_GLYPH`'s shapes, so a callout
 * and the toast or banner for the same event wear the same mark. The glyph and
 * the tint carry the severity; the words stay on the neutral ramp, because
 * status-coloured text has no contrast floor across the themes.
 */

export type CalloutSeverity = "error" | "warning" | "danger" | "success" | "info" | "neutral";

export const CALLOUT_ICON: Record<CalloutSeverity, LucideIcon> = {
  error: SEVERITY_GLYPH.error,
  warning: SEVERITY_GLYPH.warning,
  danger: OctagonAlert,
  success: SEVERITY_GLYPH.success,
  info: SEVERITY_GLYPH.info,
  neutral: SEVERITY_GLYPH.info,
};

export const calloutVariants = cva("flex items-start rounded-[var(--radius-md)] border", {
  variants: {
    severity: {
      error: "border-status-error/20 bg-status-error/10",
      warning: "border-status-warning/20 bg-status-warning/10",
      danger: "border-status-danger/20 bg-status-danger/10",
      success: "border-status-success/20 bg-status-success/10",
      info: "border-status-info/20 bg-status-info/10",
      neutral: "border-border-default bg-overlay-subtle",
    },
    size: {
      default: "gap-2 px-3 py-2 text-xs",
      // Dense surfaces whose own copy is already `text-2xs` — plugin rows and cards.
      compact: "gap-2 px-2.5 py-2 text-2xs",
    },
  },
  defaultVariants: { severity: "error", size: "default" },
});

export const CALLOUT_ICON_TONE: Record<CalloutSeverity, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  danger: "text-status-danger",
  success: "text-status-success",
  info: "text-status-info",
  neutral: "text-text-secondary",
};

// Centred on the first line: 16px on a `text-xs` body line or, nudged down, on a
// `text-sm` title; 14px on the compact `text-2xs` body or `text-xs` title.
const ICON_SIZE = {
  default: "w-4 h-4",
  compact: "w-3.5 h-3.5 mt-px",
} as const;

// One step above the body, the way `InlineStatusBanner` titles its band, so a
// banner and a callout in the same dialog read as one family.
const TITLE_SIZE = {
  default: "text-sm",
  compact: "text-xs",
} as const;

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  severity: CalloutSeverity;
  ref?: React.Ref<HTMLDivElement>;
  size?: "default" | "compact";
  /** A short headline. The body under it steps down to secondary text. */
  title?: React.ReactNode;
  /** One trailing control beside the message — a Retry. Anything more goes in the body. */
  action?: React.ReactNode;
  /** A domain glyph in place of `Info`, for `neutral` only: every other tone's glyph is its severity. */
  icon?: LucideIcon;
}

export function Callout({
  severity,
  size = "default",
  title,
  action,
  icon,
  className,
  children,
  ...props
}: CalloutProps) {
  const Icon = (severity === "neutral" && icon) || CALLOUT_ICON[severity];
  return (
    <div
      {...props}
      data-callout={severity}
      className={cn(calloutVariants({ severity, size }), className)}
    >
      <Icon
        className={cn(
          ICON_SIZE[size],
          title && size === "default" && "mt-0.5",
          "shrink-0",
          CALLOUT_ICON_TONE[severity]
        )}
        aria-hidden="true"
        data-severity-glyph=""
      />
      <div
        className={cn(
          "min-w-0 flex-1 break-words",
          title ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {title && (
          <p className={cn("mb-0.5 font-medium text-text-primary", TITLE_SIZE[size])}>{title}</p>
        )}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
