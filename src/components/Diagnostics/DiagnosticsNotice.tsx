import type { ReactNode } from "react";
import { CircleAlert, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface DiagnosticsNoticeProps {
  /** `failed`: nothing to show. `stale`: older data is still on screen below. */
  kind: "failed" | "stale";
  title: string;
  description?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

/**
 * The inline notice a diagnostics tab shows when its own data source fails.
 * The glyph carries the kind (a shape, so it survives forced colours) and the
 * text stays neutral for contrast. It is a polite status region: a refresh
 * that starts failing is announced once, without moving focus.
 */
export function DiagnosticsNotice({
  kind,
  title,
  description,
  onRetry,
  retrying = false,
  className,
}: DiagnosticsNoticeProps) {
  const Glyph = kind === "failed" ? CircleAlert : History;
  return (
    <div
      role="status"
      aria-live="polite"
      data-notice={kind}
      className={cn(
        "flex items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2",
        kind === "failed"
          ? "border-status-error/50 bg-status-error/5"
          : "border-status-warning/50 bg-status-warning/5",
        className
      )}
    >
      <Glyph
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-3.5 w-3.5 shrink-0",
          kind === "failed" ? "text-status-error" : "text-status-warning"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-primary">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-text-secondary">{description}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="subtle" size="xs" onClick={onRetry} disabled={retrying}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
