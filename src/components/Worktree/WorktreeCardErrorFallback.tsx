import { TriangleAlert } from "lucide-react";
import type { ErrorFallbackProps } from "@/components/ErrorBoundary/ErrorFallback";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

export function WorktreeCardErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const message = import.meta.env.DEV ? error.message : "Card failed to render";
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-divider bg-[color-mix(in_oklab,var(--color-status-error)_6%,transparent)]">
      <TriangleAlert className="size-4 shrink-0 text-status-error" />
      <TruncatedTooltip content={message}>
        <span className="text-xs text-daintree-text/70 truncate flex-1">{message}</span>
      </TruncatedTooltip>
      <button
        type="button"
        onClick={resetError}
        className="shrink-0 text-xs px-2 py-0.5 rounded bg-status-error/10 text-status-error hover:bg-status-error/20 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
