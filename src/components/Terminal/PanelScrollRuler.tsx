import { useCallback, useMemo, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { panelStoreApi, type TerminalInstance } from "@/store";
import type { TabGroup } from "@shared/types/panel";
import {
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

export interface PanelScrollRulerProps {
  /** The grid's scroll container; `null` disables the ruler. */
  scrollRoot: HTMLElement | null;
  /** Grid tab groups in render order. The active panel of each group drives one tick. */
  tabGroups: TabGroup[];
  /** Currently focused panel id, highlighted on the ruler. */
  focusedId: string | null;
}

/**
 * Proportional scroll-track ruler painted on the right edge of the scrollable
 * panel grid. Renders one tick per grid panel, coloured by agent state, so the
 * user can scan the whole fleet — including panels currently scrolled out of
 * view — at a glance. Clicking a tick scrolls that panel into the viewport.
 *
 * Replaces the read-only overflow status strip (#8702) for the scrolling grid
 * model introduced in #8805. The strip's "Click to dock" affordance is dropped
 * here intentionally: panels stay in the grid; the ruler is a navigation aid,
 * not a relocation surface.
 */
export function PanelScrollRuler({ scrollRoot, tabGroups, focusedId }: PanelScrollRulerProps) {
  // Re-render on any panel-store mutation so agent-state ticks update tick
  // colours without forcing a global memo invalidation upstream.
  useSyncExternalStore(panelStoreApi.subscribe, panelStoreApi.getState);

  const activePanels = useMemo(() => {
    const byId = panelStoreApi.getState().panelsById;
    const result: TerminalInstance[] = [];
    for (const group of tabGroups) {
      const activeId = group.panelIds.includes(group.activeTabId)
        ? group.activeTabId
        : (group.panelIds[0] ?? null);
      if (!activeId) continue;
      const panel = byId[activeId];
      if (panel) result.push(panel);
    }
    return result;
  }, [tabGroups]);

  const handleJump = useCallback((panelId: string) => {
    const element = document.querySelector<HTMLElement>(`[data-panel-id="${panelId}"]`);
    element?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, []);

  if (!scrollRoot) return null;
  if (activePanels.length < 2) return null;

  return (
    <div
      role="navigation"
      aria-label="Panel overview"
      className="pointer-events-none absolute inset-y-1 right-1 flex w-3 flex-col items-stretch gap-px"
    >
      {activePanels.map((panel) => (
        <PanelScrollRulerTick
          key={panel.id}
          panel={panel}
          isFocused={panel.id === focusedId}
          onJump={handleJump}
        />
      ))}
    </div>
  );
}

interface PanelScrollRulerTickProps {
  panel: TerminalInstance;
  isFocused: boolean;
  onJump: (panelId: string) => void;
}

function PanelScrollRulerTick({ panel, isFocused, onJump }: PanelScrollRulerTickProps) {
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
  const stateColor = displayAgentState ? getEffectiveStateColor(displayAgentState) : null;
  const stateLabel = displayAgentState ? getEffectiveStateLabel(displayAgentState) : "idle";
  const isOffscreen = panel.isVisible === false;

  return (
    <button
      type="button"
      data-ruler-tick=""
      data-panel-id={panel.id}
      data-state={displayAgentState ?? "idle"}
      data-offscreen={isOffscreen ? "true" : undefined}
      onClick={() => onJump(panel.id)}
      title={`${panel.title} (${stateLabel})`}
      aria-label={`Scroll to ${panel.title}, ${stateLabel}`}
      className={cn(
        "pointer-events-auto block flex-1 min-h-[6px] w-full rounded-[1px]",
        "bg-current",
        "transition-colors duration-150 ease-out",
        stateColor ?? "text-daintree-text/30",
        // Off-screen panels lift to full opacity so an attention-needing
        // agent stays salient even when scrolled away.
        isOffscreen ? "opacity-100" : "opacity-60 hover:opacity-100",
        // Focus ring matches the rest of the grid; intentional non-accent
        // colour because the ruler is high-density and accent is reserved.
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
        "focus-visible:outline-offset-1",
        isFocused && "outline outline-1 outline-offset-1 outline-daintree-text/40"
      )}
    />
  );
}
