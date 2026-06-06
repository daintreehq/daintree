import { useCallback, type CSSProperties } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, type PanelGridState } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useScrollbackRestoreAggregate } from "@/hooks/useScrollbackRestoreAggregate";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { retryFailedScrollbackRestoreBatch } from "@/utils/stateHydration/scrollbackRestoreScheduler";

function SpinnerIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <Loader2
      className={cn("animate-spin motion-reduce:animate-none", className)}
      style={style}
      aria-hidden="true"
    />
  );
}

// Panels whose last scrollback restore failed. The per-panel banner inside each
// TerminalPane handles individual dismissal/reset; this batch banner aggregates
// them for a single "Retry batch" recovery. Dismissing every per-panel banner
// empties this list, which auto-hides the batch banner.
function selectFailedScrollbackRestoreIds(state: PanelGridState): string[] {
  const ids: string[] = [];
  for (const id of state.panelIds) {
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel) || panel.location === "trash") continue;
    if (panel.scrollbackRestoreError) ids.push(id);
  }
  return ids;
}

/**
 * Grid-level surface for batch scrollback restore. Renders, in priority order:
 *  - Tier 3 error banner with a "Retry batch" action when any panel's restore
 *    failed (persists until retried or all per-panel errors are cleared);
 *  - Tier 1 ambient "Restoring N of M" progress, gated by the 400ms Doherty
 *    threshold so sub-400ms restores never flash;
 *  - nothing when idle.
 */
export function BatchScrollbackRestoreBar({ className }: { className?: string }) {
  const { pendingCount, inProgressCount, totalCount } = useScrollbackRestoreAggregate();
  const failedIds = usePanelStore(useShallow(selectFailedScrollbackRestoreIds));

  const isRestoring = pendingCount + inProgressCount > 0;
  const showProgress = useDohertyGate(isRestoring);

  const handleRetry = useCallback(() => {
    retryFailedScrollbackRestoreBatch(failedIds);
  }, [failedIds]);

  if (failedIds.length > 0) {
    const count = failedIds.length;
    return (
      <InlineStatusBanner
        icon={History}
        title={`Restore failed for ${count} panel${count !== 1 ? "s" : ""}`}
        description="Some panels couldn't replay their earlier output. The terminals still work."
        severity="error"
        role="alert"
        ariaLive="assertive"
        className={className}
        action={{
          id: "retry-batch",
          label: "Retry batch",
          icon: RotateCcw,
          variant: "primary",
          onClick: handleRetry,
          ariaLabel: "Retry batch",
        }}
      />
    );
  }

  if (showProgress) {
    const doneCount = Math.max(0, totalCount - pendingCount - inProgressCount);
    return (
      <InlineStatusBanner
        icon={SpinnerIcon}
        title={`Restoring ${doneCount} of ${totalCount}`}
        severity="info"
        animated={false}
        role="status"
        ariaLive="polite"
        className={className}
        actions={[]}
      />
    );
  }

  return null;
}
