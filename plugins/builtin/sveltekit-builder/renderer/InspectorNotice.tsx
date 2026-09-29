import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CALLOUT_ICON,
  CALLOUT_ICON_TONE,
  calloutVariants,
  type CalloutSeverity,
} from "@/components/ui/Callout";

export type NoticeTone = "info" | "warning" | "error";

// Callout's tones, so the notice's tint, glyph and glyph ink are the primitive's
// own; only the dismiss-in-the-title-row layout is local. `info` asks nothing
// of the user, which is Callout's neutral tone.
const CALLOUT_TONE: Record<NoticeTone, CalloutSeverity> = {
  info: "neutral",
  warning: "warning",
  error: "error",
};

/**
 * A pane-local signal (T2/T3). The glyph is the tone's non-colour channel, and
 * the words carry the meaning on their own — tone never stands in for copy.
 */
export function InspectorNotice({
  tone,
  title,
  children,
  action,
  role,
  className,
  onDismiss,
  density = "default",
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  className?: string;
  /** A corner control that closes the notice. */
  onDismiss?: () => void;
  /**
   * `compact` for a routine, recoverable state the user will see often — a
   * stale selection, shared markup. Those were spending a full three-line card
   * on a sentence, and in a 360px column every line they take is a line the
   * controls move down by. Failures that need recovery instructions keep the
   * default.
   */
  density?: "default" | "compact";
}) {
  const callout = CALLOUT_TONE[tone];
  const Icon = CALLOUT_ICON[callout];
  return (
    <div
      role={role}
      data-tone={tone}
      className={cn(
        calloutVariants({ severity: callout }),
        density === "compact" && "px-2.5 py-1.5",
        className
      )}
    >
      <Icon
        className={cn("mt-px h-3.5 w-3.5 shrink-0", CALLOUT_ICON_TONE[callout])}
        aria-hidden="true"
        data-severity-glyph=""
      />
      <div
        className={cn("flex min-w-0 flex-1 flex-col", density === "compact" ? "gap-0.5" : "gap-1")}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 font-medium text-text-primary">{title}</p>
          {onDismiss ? (
            // The primitive, not a hand-rolled button: hover, focus ring,
            // radius and transition are the same ones every other icon control
            // in the product draws. The offsets pull its 24px box back onto the
            // title's optical line — the glyph inside it is still 12px.
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="-mr-1 -mt-1 shrink-0"
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {children ? <div className="text-text-secondary">{children}</div> : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
