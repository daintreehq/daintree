import { useCallback } from "react";
import { ArrowRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { HollowCircle, InteractingCircle } from "@/components/icons";
import type { TabGroup } from "@shared/types/panel";

export interface GridAttentionStripProps {
  /** Grid tab groups in render order. The active panel of each group contributes one count. */
  tabGroups: TabGroup[];
  className?: string;
}

/**
 * Bottom-of-grid strip that summarises how many agents in the scrollable
 * panel grid need attention (waiting, directing, or errored) and provides a
 * one-click jump to the next such agent. Replaces `PanelScrollRuler` from
 * #8807 — the ruler was hard to interpret and competed with the grid's own
 * scrollbar; the strip turns the same fleet signal into plain numbers.
 *
 * Renders nothing when no agent needs attention so it does not occupy
 * vertical space while everything is idle or working.
 */
export function GridAttentionStrip({ tabGroups, className }: GridAttentionStripProps) {
  const { waitingCount, directingCount, errorCount } = usePanelStore(
    useShallow((state) => {
      let waiting = 0;
      let directing = 0;
      let error = 0;
      for (const group of tabGroups) {
        const activeId = group.panelIds.includes(group.activeTabId)
          ? group.activeTabId
          : (group.panelIds[0] ?? null);
        if (!activeId) continue;
        const panel = state.panelsById[activeId];
        if (!panel) continue;
        if (panel.agentState === "waiting") waiting++;
        else if (panel.agentState === "directing") directing++;
        if (panel.runtimeStatus === "error") error++;
      }
      return { waitingCount: waiting, directingCount: directing, errorCount: error };
    })
  );

  const handleJump = useCallback(() => {
    void actionService.dispatch("terminal.jumpToNextAttention", undefined, { source: "user" });
  }, []);

  const total = waitingCount + directingCount + errorCount;
  if (total === 0) return null;

  return (
    <div
      role="status"
      aria-label="Agents needing attention"
      className={cn(
        "flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-subtle bg-overlay-subtle px-3 py-1.5 text-xs",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3 overflow-hidden text-daintree-text/80">
        {waitingCount > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <HollowCircle className="h-3 w-3 text-state-waiting" aria-hidden="true" />
            <span className="tabular-nums">{waitingCount}</span>
            <span className="text-daintree-text/60">waiting</span>
          </span>
        )}
        {directingCount > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <InteractingCircle className="h-3 w-3 text-category-blue" aria-hidden="true" />
            <span className="tabular-nums">{directingCount}</span>
            <span className="text-daintree-text/60">directing</span>
          </span>
        )}
        {errorCount > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-status-error" aria-hidden="true" />
            <span className="tabular-nums">{errorCount}</span>
            <span className="text-daintree-text/60">errored</span>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleJump}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-tint/15 bg-tint/5 px-2 py-1 text-daintree-text/80 transition-colors",
          "hover:bg-tint/10 hover:text-daintree-text",
          "outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent"
        )}
      >
        Jump to next
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
