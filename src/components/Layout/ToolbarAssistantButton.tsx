import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { useFocusStore } from "@/store/focusStore";
import { useHelpPanelStore, selectSlotTerminalIds } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { useMcpReadiness } from "@/hooks/useMcpReadiness";
import type { McpRuntimeSnapshot } from "@shared/types";
import type { AgentState } from "@/types";

const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

interface PipDescriptor {
  className: string;
  delayed: boolean;
  tooltip: string;
}

function describePip(snapshot: McpRuntimeSnapshot): PipDescriptor | null {
  switch (snapshot.state) {
    case "starting":
      return {
        className: "bg-status-warning",
        delayed: true,
        tooltip: "MCP starting…",
      };
    case "failed":
      return {
        className: "bg-status-danger",
        delayed: false,
        tooltip: snapshot.lastError ?? "MCP failed to start",
      };
    case "ready":
    case "disabled":
    default:
      return null;
  }
}

interface AgentPipDescriptor {
  className: string;
  tooltip: string;
}

// Local mapping that includes "working" — broader than the shared
// agentStateDotColor() in AgentStatusIndicator, which deliberately omits
// passive states for the worktree tray. Here the toolbar button is the only
// chrome surfacing assistant state when the panel is closed, so working and
// directing both earn the green pip alongside the yellow waiting pip.
const AGENT_PIP_BY_STATE = {
  working: { className: "bg-state-working", tooltip: "Assistant is working" },
  directing: { className: "bg-state-working", tooltip: "Assistant is working" },
  waiting: { className: "bg-state-waiting", tooltip: "Assistant is waiting" },
} as const satisfies Record<
  Extract<AgentState, "working" | "directing" | "waiting">,
  AgentPipDescriptor
>;

function describeAgentPip(state: AgentState | null | undefined): AgentPipDescriptor | null {
  if (state == null) return null;
  return (AGENT_PIP_BY_STATE as Partial<Record<AgentState, AgentPipDescriptor>>)[state] ?? null;
}

export function ToolbarAssistantButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const isOpen = useHelpPanelStore((s) => s.isOpen);
  const toggle = useHelpPanelStore((s) => s.toggle);
  // The panel's actual visibility in AppLayout is `!gestureAssistantHidden &&
  // helpPanelOpen` — two independent stores. Reading only `isOpen` here would
  // leave the button highlighted (aria-pressed, suppressed pip) while the
  // focus-mode gesture hides the panel. Mirror the same
  // compound predicate so the visual state can't drift from what the user
  // actually sees.
  const gestureAssistantHidden = useFocusStore((s) => s.gestureAssistantHidden);
  const isVisible = !gestureAssistantHidden && isOpen;
  // Two-step selectors so the button only re-renders when the set of assistant
  // terminals changes, then when the reported agentState transitions.
  // Aggregate across lanes (#12108). The button is the one place a background
  // assistant can ask for the user, so it reports the most demanding lane
  // rather than the focused one — surfacing "one of your assistants is
  // waiting" is the whole point of the pip, and reporting only the active lane
  // would hide exactly the session the user has navigated away from.
  const assistantTerminalIds = useHelpPanelStore(useShallow(selectSlotTerminalIds));
  const agentState = usePanelStore((s) => {
    let best: AgentState | null = null;
    for (const terminalId of assistantTerminalIds) {
      const p = s.panelsById[terminalId];
      if (!p || !isPtyPanel(p)) continue;
      const state = p.agentState ?? null;
      if (state === null) continue;
      // "waiting" outranks everything: it is the only state that is a request
      // for the user. Otherwise first live lane wins.
      if (state === "waiting") return state;
      best ??= state;
    }
    return best;
  });
  const mcp = useMcpReadiness();
  const shortcut = useKeybindingDisplay("help.togglePanel");
  const ariaShortcut = useAriaKeyshortcuts("help.togglePanel");
  const hintHover = useShortcutHintHover("help.togglePanel");

  // "Mark as read" semantics for the agent pip: track the (terminalId, state)
  // tuple the user last saw while the panel was open so the pip only surfaces
  // unread *changes* while the panel is closed. Scoping to terminalId means a
  // respawned assistant landing on the same state value still reads as unread
  // — a fresh session is always a new event. While the panel is open we keep
  // the marker in lockstep with the live state, so closing freezes it at
  // whatever the user just saw and closing without further change leaves the
  // pip hidden.
  const [lastSeenMarker, setLastSeenMarker] = useState<{
    terminalKey: string;
    state: AgentState | null;
  } | null>(null);
  // Identity is the whole set of lanes, not one id (#12108): opening or closing
  // a session changes what the pip is reporting on, so a marker taken against
  // the old set must stop counting as "already read".
  const assistantTerminalKey = assistantTerminalIds.join("\u0000");
  useEffect(() => {
    if (isVisible) {
      setLastSeenMarker({ terminalKey: assistantTerminalKey, state: agentState });
    }
  }, [isVisible, assistantTerminalKey, agentState]);

  const handleClick = useCallback(() => {
    suppressSidebarResizes();
    // When the gesture hides a logically-open panel the button reads as
    // closed; clearing the gesture alone reveals it. Calling toggle() on
    // top would flip isOpen to false and re-hide what the user just asked
    // to reveal. Only toggle when clearing the gesture wouldn't already
    // restore visibility.
    const wasGestureHidden = useFocusStore.getState().gestureAssistantHidden;
    useFocusStore.getState().clearAssistantGesture();
    if (!wasGestureHidden || !isOpen) {
      toggle();
    }
  }, [toggle, isOpen]);

  const pip = describePip(mcp);
  const agentPip = describeAgentPip(agentState);
  // The MCP-health pip takes precedence — when it's showing, the agent pip
  // would compete for the same corner. The agent pip is suppressed while the
  // panel is open (the in-panel header indicator already conveys state) and
  // also when the live state matches what the user last saw — once read, it
  // stays quiet until a real state change.
  const isAcknowledged =
    lastSeenMarker !== null &&
    lastSeenMarker.terminalKey === assistantTerminalKey &&
    lastSeenMarker.state === agentState;
  const showAgentPip = !pip && agentPip !== null && !isVisible && !isAcknowledged;
  // Subject plus status, never "Open/Close … — status": joined to an action
  // verb, the status read as the reason to take it (#12509). aria-pressed
  // already carries open/closed, and toggle labels don't change with state.
  const label = pip
    ? `Daintree Assistant — ${pip.tooltip}`
    : showAgentPip
      ? `Daintree Assistant — ${agentPip!.tooltip}`
      : "Daintree Assistant";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...hintHover}
          type="button"
          variant="ghost"
          size="icon"
          data-toolbar-item={dataToolbarItem}
          onClick={handleClick}
          className={toolbarIconButtonClass}
          aria-label={label}
          aria-pressed={isVisible}
          aria-keyshortcuts={ariaShortcut}
        >
          <div className="relative">
            <DaintreeIcon />
            {/* One always-in-DOM pip; data-visible drives the @starting-style
                enter/exit on .toolbar-badge. Precedence (MCP pip > agent pip)
                stays in component logic — the className resolves to the winning
                pip's color, with the pulse only on the delayed MCP state. */}
            <span
              aria-hidden="true"
              data-testid="assistant-working-pip"
              data-agent-state={agentState ?? ""}
              data-visible={pip !== null || showAgentPip}
              className={cn(
                "toolbar-pip toolbar-badge",
                pip?.className ?? (showAgentPip ? agentPip?.className : undefined),
                pip?.delayed && "animate-pulse-delayed"
              )}
            />
          </div>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{createTooltipContent(label, shortcut)}</TooltipContent>
    </Tooltip>
  );
}
