import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
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
// agentStateDotColor() in terminalStateConfig, which deliberately omits
// passive states for the agent buttons. Here the toolbar button is the only
// chrome surfacing assistant state when the panel is closed, so working earns
// a pip too. Each state keeps the hue of its canonical glyph.
const AGENT_PIP_BY_STATE = {
  working: { className: "bg-state-working", tooltip: "Assistant is working" },
  directing: { className: "bg-category-blue", tooltip: "You're directing the assistant" },
  waiting: { className: "bg-state-waiting", tooltip: "Assistant is waiting" },
} as const satisfies Record<
  Extract<AgentState, "working" | "directing" | "waiting">,
  AgentPipDescriptor
>;

// Waiting is the only request for the user, so it outranks everything; a
// state that earns a pip outranks one that does not, whichever lane it is in.
const ASSISTANT_PIP_PRIORITY = [
  "waiting",
  "working",
  "directing",
] as const satisfies readonly AgentState[];

function mostDemandingState(states: readonly (AgentState | null)[]): AgentState | null {
  for (const candidate of ASSISTANT_PIP_PRIORITY) {
    if (states.includes(candidate)) return candidate;
  }
  return states.find((state) => state !== null) ?? null;
}

function describeAgentPip(state: AgentState | null | undefined): AgentPipDescriptor | null {
  if (state == null) return null;
  return (AGENT_PIP_BY_STATE as Partial<Record<AgentState, AgentPipDescriptor>>)[state] ?? null;
}

const laneKey = (terminalId: string, state: AgentState | null) =>
  `${terminalId}\u0000${state ?? ""}`;

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
  const laneStates = usePanelStore(
    useShallow((s) =>
      assistantTerminalIds.map((terminalId) => {
        const p = s.panelsById[terminalId];
        return p && isPtyPanel(p) ? (p.agentState ?? null) : null;
      })
    )
  );
  const agentState = mostDemandingState(laneStates);
  const mcp = useMcpReadiness();
  const shortcut = useEffectiveCombo("help.togglePanel");
  const ariaShortcut = useAriaKeyshortcuts("help.togglePanel");
  const hintHover = useShortcutHintHover("help.togglePanel");

  // "Mark as read" semantics for the agent pip: remember every (terminalId,
  // state) pair the user saw while the panel was open, so the pip only surfaces
  // unread *changes* while the panel is closed. Per lane, not per aggregate
  // (#12108): with one lane already acknowledged as waiting, a second lane
  // that starts waiting is a new request and must not hide behind the first.
  // Scoping to terminalId means a respawned assistant landing on the same state
  // value still reads as unread — a fresh session is always a new event. While
  // the panel is open the set tracks the live lanes, so closing freezes it at
  // whatever the user just saw.
  const laneKeys = assistantTerminalIds.map((terminalId, i) =>
    laneKey(terminalId, laneStates[i] ?? null)
  );
  const laneKeysJoined = laneKeys.join("\u0001");
  const [seenLaneKeys, setSeenLaneKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (isVisible) {
      setSeenLaneKeys(new Set(laneKeysJoined ? laneKeysJoined.split("\u0001") : []));
    }
  }, [isVisible, laneKeysJoined]);
  const unreadState = mostDemandingState(
    laneStates.filter((_, i) => !seenLaneKeys.has(laneKeys[i]!))
  );

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
  const agentPip = describeAgentPip(unreadState);
  // The MCP-health pip takes precedence — when it's showing, the agent pip
  // would compete for the same corner. The agent pip is suppressed while the
  // panel is open (the in-panel header indicator already conveys state), and
  // it reports only lanes whose state the user has not yet seen — once read, a
  // lane stays quiet until it really changes.
  const showAgentPip = !pip && agentPip !== null && !isVisible;
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
