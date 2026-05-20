import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { getBaseTitle } from "@/lib/utils";
import { panelStoreApi, type TerminalInstance } from "@/store";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { TabGroup } from "@shared/types/panel";
import { actionService } from "@/services/ActionService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

/**
 * Compact status cards for panels that exceed the grid's screen-fit capacity.
 *
 * When the active worktree has more grid panels than fit at MIN_TERMINAL_WIDTH_PX
 * × MIN_TERMINAL_HEIGHT_PX, the overflow set renders here as read-only cards
 * surfacing agent state and current activity — never below readability — instead
 * of squeezing every live terminal into the grid. See #8702.
 *
 * Clicking a card sends the panel to the dock via `terminal.moveToDock`, where
 * the user can interact with the agent at full size. Swap-on-click (promotion
 * back into the grid) is intentionally deferred — the promotion state machine
 * adds reset paths that are out of scope for the MVP.
 */
export interface OverflowStatusStripProps {
  groups: TabGroup[];
  className?: string;
}

export function OverflowStatusStrip({ groups, className }: OverflowStatusStripProps) {
  // Demote overflow panels to BACKGROUND so the analysis buffer keeps writing
  // (state detection stays accurate) while visual streaming is suppressed.
  // Restoring to VISIBLE on unmount lets the grid renderer show them at full
  // refresh when capacity grows or panels move; the dock toggles BACKGROUND on
  // its own when applicable.
  const overflowPanelIds = useMemo(() => {
    const ids: string[] = [];
    const byId = panelStoreApi.getState().panelsById;
    for (const group of groups) {
      for (const panelId of group.panelIds) {
        if (byId[panelId]) ids.push(panelId);
      }
    }
    return ids;
  }, [groups]);

  useEffect(() => {
    for (const id of overflowPanelIds) {
      try {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
      } catch {
        // Renderer may not have an instance yet — that's fine, the next
        // mount will pick up the visible tier.
      }
    }
    return () => {
      for (const id of overflowPanelIds) {
        try {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        } catch {
          // Ditto: a panel may have been removed before unmount completes.
        }
      }
    };
  }, [overflowPanelIds]);

  if (groups.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Overflow agents"
      className={cn(
        "shrink-0 border-t border-daintree-border/40 bg-daintree-bg/40 px-2 py-1.5",
        className
      )}
    >
      <div className="flex items-center justify-between mb-1 px-0.5">
        <span className="text-[11px] uppercase tracking-wide text-daintree-text/50">
          {groups.length} more {groups.length === 1 ? "agent" : "agents"}
        </span>
        <span className="text-[11px] text-daintree-text/40">Click to move to dock</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {groups.map((group) => (
          <OverflowCard key={group.id} group={group} />
        ))}
      </div>
    </div>
  );
}

interface OverflowCardProps {
  group: TabGroup;
}

function OverflowCard({ group }: OverflowCardProps) {
  // Read the active panel for this group non-reactively. Cards live in the
  // overflow strip — they don't need per-tick rerenders, but they should
  // pick up the latest title/agent-state on each parent render.
  const byId = panelStoreApi.getState().panelsById;
  const activeId = group.panelIds.includes(group.activeTabId)
    ? group.activeTabId
    : (group.panelIds[0] ?? null);
  const panel = activeId ? byId[activeId] : null;

  if (!panel) return null;

  return <OverflowCardContent panel={panel} groupSize={group.panelIds.length} />;
}

interface OverflowCardContentProps {
  panel: TerminalInstance;
  groupSize: number;
}

function OverflowCardContent({ panel, groupSize }: OverflowCardContentProps) {
  const chrome = deriveTerminalChrome({
    kind: panel.kind,
    launchAgentId: panel.launchAgentId,
    runtimeIdentity: panel.runtimeIdentity,
    detectedAgentId: panel.detectedAgentId,
    detectedProcessId: panel.detectedProcessId,
    agentState: panel.agentState,
    runtimeStatus: panel.runtimeStatus,
    exitCode: panel.exitCode,
  });
  const displayAgentState = getTerminalAgentDisplayState(chrome, panel.agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;
  const stateColor = displayAgentState ? getEffectiveStateColor(displayAgentState) : null;
  const stateLabel = displayAgentState ? getEffectiveStateLabel(displayAgentState) : null;
  const title = getBaseTitle(panel.title);
  const headline = panel.activityHeadline?.trim() || panel.lastCommand?.trim() || null;

  return (
    <button
      type="button"
      data-overflow-card=""
      data-panel-id={panel.id}
      style={{ contain: "layout style" }}
      className={cn(
        "group flex items-start gap-2 w-[220px] min-w-0 px-2 py-1.5 text-left",
        "rounded-[var(--radius-md)] border border-daintree-border/40 bg-overlay-subtle/60",
        "transition-colors duration-150 ease-out",
        "hover:bg-overlay-subtle hover:border-daintree-border/60",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
        "focus-visible:outline-offset-[-2px]"
      )}
      onClick={() => {
        void actionService.dispatch(
          "terminal.moveToDock",
          { terminalId: panel.id },
          { source: "user" }
        );
      }}
      aria-label={
        stateLabel
          ? `${title} (${stateLabel}). Click to move to dock.`
          : `${title}. Click to move to dock.`
      }
    >
      {StateIcon ? (
        <div className={cn("flex items-center justify-center shrink-0 mt-0.5", stateColor)}>
          <StateIcon
            className={cn(
              "w-3.5 h-3.5",
              displayAgentState === "working" && "animate-spin-slow",
              "motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      )}
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-xs font-medium text-daintree-text truncate">
          {title}
          {groupSize > 1 ? (
            <span className="ml-1 text-[11px] text-daintree-text/50 font-normal">
              ({groupSize} tabs)
            </span>
          ) : null}
        </span>
        {headline ? (
          <span className="text-[11px] text-daintree-text/60 truncate font-mono">{headline}</span>
        ) : (
          <span className="text-[11px] text-daintree-text/40 truncate">{stateLabel ?? "Idle"}</span>
        )}
      </div>
    </button>
  );
}
