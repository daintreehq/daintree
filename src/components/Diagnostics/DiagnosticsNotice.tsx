import type { ReactNode } from "react";
import { History } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";

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
 * The inline notice a diagnostics tab shows when its own data source fails —
 * in the `strip` layout, so Retry sits beside the text rather than on a row
 * of its own and the notice costs one line of a 256px dock, not three —
 * the same in-pane `InlineStatusBanner` the file browser and review hub use
 * for a failed read, so a failure looks the same wherever it happens. A polite
 * status region: a refresh that starts failing is announced once, without
 * moving focus.
 */
export function DiagnosticsNotice({
  kind,
  title,
  description,
  onRetry,
  retrying = false,
  className,
}: DiagnosticsNoticeProps) {
  const action = onRetry
    ? { id: "retry", label: "Retry", onClick: onRetry, loading: retrying }
    : undefined;
  return (
    <div data-notice={kind} className={className}>
      {kind === "failed" ? (
        <InlineStatusBanner
          severity="error"
          layout="strip"
          role="status"
          ariaLive="polite"
          title={title}
          description={description}
          action={action}
        />
      ) : (
        <InlineStatusBanner
          severity="warning"
          icon={History}
          layout="strip"
          role="status"
          ariaLive="polite"
          title={title}
          description={description}
          action={action}
        />
      )}
    </div>
  );
}
