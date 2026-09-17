import type { ReactNode } from "react";
import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-border-subtle bg-surface-inset",
  warning: "border-status-warning/40 bg-status-warning/10",
  error: "border-status-error/40 bg-status-error/10",
};

const ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-text-secondary",
  warning: "text-status-warning",
  error: "text-status-error",
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
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      role={role}
      data-tone={tone}
      className={cn(
        "flex gap-2 rounded-md border text-xs",
        density === "compact" ? "px-2.5 py-1.5" : "px-3 py-2",
        TONE_CLASS[tone],
        className
      )}
    >
      <Icon className={cn("mt-px h-3.5 w-3.5 shrink-0", ICON_CLASS[tone])} aria-hidden="true" />
      <div
        className={cn("flex min-w-0 flex-1 flex-col", density === "compact" ? "gap-0.5" : "gap-1")}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 font-medium text-text-primary">{title}</p>
          {onDismiss ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="-mr-1 -mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-raised hover:text-text-primary"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {children ? <div className="text-text-secondary">{children}</div> : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
