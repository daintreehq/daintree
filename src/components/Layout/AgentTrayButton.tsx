import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plug, Pin, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig, type AgentIconProps } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useActionMruStore } from "@/store/actionMruStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useShallow } from "zustand/react/shallow";
import { useKeybindingDisplay } from "@/hooks";
import { useAgentDiscoveryOnboarding } from "@/hooks/app/useAgentDiscoveryOnboarding";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import type { CliAvailability, AgentState } from "@shared/types";
import { isAgentReady, isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import {
  getDominantAgentState,
  agentStateDotColor,
} from "@/components/Worktree/AgentStatusIndicator";
import { cn } from "@/lib/utils";

interface AgentTrayButtonProps {
  agentAvailability?: CliAvailability;
  "data-toolbar-item"?: string;
}

type AgentRow = {
  id: BuiltInAgentId;
  name: string;
  Icon: ComponentType<AgentIconProps>;
  pinned: boolean;
  dominantState: AgentState | null;
  isNew: boolean;
};

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "running",
  "waiting",
  "directing",
]);

function buildAgentRow(
  id: BuiltInAgentId,
  pinned: boolean,
  dominantState: AgentState | null,
  isNew: boolean
): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  return { id, name: config.name, Icon: config.icon, pinned, dominantState, isNew };
}

function RunningDot({ state }: { state: AgentState | null }) {
  if (!state) return null;
  return (
    <span
      className={cn(
        "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-daintree-sidebar",
        agentStateDotColor(state)
      )}
      aria-hidden="true"
    />
  );
}

export function AgentTrayButton({
  agentAvailability,
  "data-toolbar-item": dataToolbarItem,
}: AgentTrayButtonProps) {
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);

  const getSortedActionMruList = useActionMruStore(useShallow((s) => s.getSortedActionMruList));

  const refreshAvailability = useCliAvailabilityStore((s) => s.refresh);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const {
    loaded: onboardingLoaded,
    seenAgentIds,
    welcomeCardDismissed,
    markAgentsSeen,
  } = useAgentDiscoveryOnboarding();

  const panelsById = usePanelStore(useShallow((s) => s.panelsById));
  const panelIds = usePanelStore(useShallow((s) => s.panelIds));
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  // Before the first real availability result lands we can't distinguish
  // "all agents missing" from "still detecting", so we show a spinner.
  const isAvailabilityLoading = agentAvailability === undefined || !hasRealData;
  const lastPinActionAt = useRef(0);

  // Radix Tooltip reopens whenever the trigger receives focus, including
  // programmatic focus restoration from DropdownMenu's onCloseAutoFocus. Gate
  // the Tooltip via controlled state and suppress open=true for one tick
  // after the dropdown closes so the refocused button doesn't flash the
  // tooltip back into view. See issue #5153.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  const restoreFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-probe on view visibility changes (Electron LRU reactivation, tab
  // switches). The window-focus trigger is handled once globally in
  // useAgentLauncher; both paths share the 30s throttle in the store.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let disposed = false;
    const handleVisibility = () => {
      if (disposed) return;
      if (document.visibilityState !== "visible") return;
      void refreshAvailability().catch(() => {});
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshAvailability]);

  useEffect(() => {
    return () => {
      if (restoreFocusTimerRef.current != null) {
        clearTimeout(restoreFocusTimerRef.current);
      }
    };
  }, []);

  const handleTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  };

  const suppressTooltipDuringFocusRestore = () => {
    setTooltipOpen(false);
    isRestoringFocusRef.current = true;
    if (restoreFocusTimerRef.current != null) {
      clearTimeout(restoreFocusTimerRef.current);
    }
    restoreFocusTimerRef.current = setTimeout(() => {
      isRestoringFocusRef.current = false;
      restoreFocusTimerRef.current = null;
    }, 0);
  };

  const agentDominantStates = useMemo(() => {
    const statesPerAgent = new Map<string, (AgentState | undefined)[]>();
    for (const pid of panelIds) {
      const p = panelsById[pid];
      if (
        !p ||
        p.kind !== "agent" ||
        !p.agentId ||
        p.location === "trash" ||
        p.location === "background"
      )
        continue;
      if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
      if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
      const arr = statesPerAgent.get(p.agentId) ?? [];
      arr.push(p.agentState);
      statesPerAgent.set(p.agentId, arr);
    }
    const result = new Map<string, AgentState | null>();
    for (const [agentId, states] of statesPerAgent) {
      result.set(agentId, getDominantAgentState(states));
    }
    return result;
  }, [panelsById, panelIds, activeWorktreeId]);

  const readyAgentIds = useMemo(() => {
    return BUILT_IN_AGENT_IDS.filter((id) => isAgentReady(agentAvailability?.[id]));
  }, [agentAvailability]);

  const hasNoPinnedAgents = useMemo(() => {
    if (!agentSettings?.agents) return true;
    return !BUILT_IN_AGENT_IDS.some((id) => isAgentPinned(agentSettings.agents?.[id]));
  }, [agentSettings]);

  // While the first-run welcome card is actually being rendered, suppress
  // the tray discovery badge so the card and badge don't both fire for the
  // same agents. Critically, this is gated on whether the card would render
  // right now — not whether the dismiss flag is false — so a user who pins
  // via the tray/settings (which leaves `welcomeCardDismissed: false`)
  // still gets Day-N discovery for agents installed later.
  const welcomeCardRenderable =
    onboardingLoaded &&
    hasRealData &&
    !welcomeCardDismissed &&
    readyAgentIds.length > 0 &&
    hasNoPinnedAgents;

  const newAgentIds = useMemo<ReadonlySet<string>>(() => {
    if (!onboardingLoaded || welcomeCardRenderable) return new Set<string>();
    const set = new Set<string>();
    for (const id of readyAgentIds) {
      if (!seenAgentIds.includes(id)) set.add(id);
    }
    return set;
  }, [onboardingLoaded, welcomeCardRenderable, readyAgentIds, seenAgentIds]);

  const showDiscoveryBadge = newAgentIds.size > 0;

  const { launchable, needsSetup, fallbackSetup } = useMemo(() => {
    const launchable: AgentRow[] = [];
    const needsSetup: AgentRow[] = [];
    const fallbackSetup: AgentRow[] = [];

    for (const id of BUILT_IN_AGENT_IDS) {
      const pinned = isAgentPinned(agentSettings?.agents?.[id]);
      const dominant = agentDominantStates.get(id) ?? null;
      const row = buildAgentRow(id, pinned, dominant, newAgentIds.has(id));
      if (!row) continue;

      const state = agentAvailability?.[id];
      if (isAgentReady(state)) {
        // Pinned agents already live in the main toolbar — listing them in
        // the tray's Launch section wastes dropdown space. Users unpin via
        // the main toolbar button or Settings > Toolbar.
        if (!pinned) launchable.push(row);
      } else if (isAgentInstalled(state)) {
        // "installed" means the CLI is on PATH but not fully authenticated
        // or configured yet. These belong in "Needs Setup" with a setup
        // badge. Missing agents do NOT get promoted here.
        needsSetup.push(row);
      }
      // Always build a fallback row so we can offer discovery when
      // nothing is installed on this machine.
      fallbackSetup.push(row);
    }

    // Sort Launch by palette frecency (higher score = more recent). Untracked
    // agents keep their natural BUILT_IN_AGENT_IDS order after any tracked
    // ones. Only palette dispatches populate frecency; tray launches
    // don't record, but palette-sourced frecency is the signal we have.
    const frecencyEntries = getSortedActionMruList();
    const frecencyScoreMap = new Map<string, number>();
    frecencyEntries.forEach(({ id, score }) => frecencyScoreMap.set(id, score));

    launchable.sort((a, b) => {
      const aScore = frecencyScoreMap.get(`agent.${a.id}`) ?? -Infinity;
      const bScore = frecencyScoreMap.get(`agent.${b.id}`) ?? -Infinity;
      if (aScore === -Infinity && bScore === -Infinity) return 0;
      if (aScore === -Infinity) return 1;
      if (bScore === -Infinity) return -1;
      return bScore - aScore;
    });

    return { launchable, needsSetup, fallbackSetup };
  }, [agentAvailability, agentSettings, agentDominantStates, getSortedActionMruList, newAgentIds]);

  const handleLaunch = (row: AgentRow) => {
    void actionService.dispatch("agent.launch", { agentId: row.id }, { source: "user" });
  };

  const handleSetup = (agentId: BuiltInAgentId) => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: agentId },
      { source: "user" }
    );
  };

  const handleCustomizeToolbar = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "toolbar" }, { source: "user" });
  };

  const handleManageAgents = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  };

  const handleOpenChange = (open: boolean) => {
    setTooltipOpen(false);
    if (!open) return;
    // Fire-and-forget: the store throttle absorbs rapid reopens.
    void refreshAvailability().catch(() => {});
    if (readyAgentIds.length > 0) {
      void markAgentsSeen(readyAgentIds);
    }
  };

  const togglePin = (row: AgentRow) => {
    const now = Date.now();
    if (now - lastPinActionAt.current < 50) return;
    lastPinActionAt.current = now;
    void setAgentPinned(row.id, !row.pinned);
  };

  const stopPointer = (e: ReactPointerEvent) => {
    e.stopPropagation();
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: AgentRow) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      togglePin(row);
    }
  };

  const hasAnyContent = launchable.length > 0 || needsSetup.length > 0;
  // Show every built-in with a Setup badge if nothing is installed — discovery
  // over an unhelpful "No agents available" dead end. Only kicks in once real
  // availability data has landed.
  const showFallback = !isAvailabilityLoading && !hasAnyContent && fallbackSetup.length > 0;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <TooltipProvider>
        <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                className="toolbar-agent-button text-daintree-text hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] focus-visible:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] transition-colors"
                aria-label={showDiscoveryBadge ? "Agent tray — new agents detected" : "Agent tray"}
              >
                <span className="relative inline-flex items-center justify-center">
                  <Plug />
                  {showDiscoveryBadge && (
                    <span
                      data-testid="agent-tray-discovery-badge"
                      className="absolute top-0 right-0 size-1.5 rounded-full bg-sky-400 ring-1 ring-daintree-sidebar"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Agent Tray</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[16rem]"
        onCloseAutoFocus={() => {
          suppressTooltipDuringFocusRestore();
        }}
      >
        {isAvailabilityLoading && (
          <div className="px-2.5 py-1.5 text-xs text-daintree-text/60">Checking agents…</div>
        )}

        {launchable.length > 0 && (
          <>
            <DropdownMenuLabel>Launch</DropdownMenuLabel>
            {launchable.map((row) => (
              <LaunchRow
                key={`launch-${row.id}`}
                row={row}
                onLaunch={handleLaunch}
                onKeyDown={handleRowKeyDown}
                onTogglePin={togglePin}
                stopPointer={stopPointer}
              />
            ))}
          </>
        )}

        {needsSetup.length > 0 && (
          <>
            {launchable.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>Needs Setup</DropdownMenuLabel>
            {needsSetup.map((row) => (
              <DropdownMenuItem
                key={`setup-${row.id}`}
                onSelect={() => handleSetup(row.id)}
                className="group h-7"
              >
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center grayscale opacity-50">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                <span className="flex-1 text-daintree-text/70">{row.name}</span>
                <span className="ml-2 shrink-0 rounded border border-daintree-text/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-daintree-text/50">
                  Setup
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {showFallback && (
          <>
            <DropdownMenuLabel>Available Agents</DropdownMenuLabel>
            {fallbackSetup.map((row) => (
              <DropdownMenuItem
                key={`fallback-${row.id}`}
                onSelect={() => handleSetup(row.id)}
                className="group h-7"
                data-testid={`agent-tray-fallback-${row.id}`}
              >
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center grayscale opacity-50">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                <span className="flex-1 text-daintree-text/70">{row.name}</span>
                <span className="ml-2 shrink-0 rounded border border-daintree-text/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-daintree-text/50">
                  Setup
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {(hasAnyContent || showFallback) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={handleManageAgents} className="h-7">
          <Settings2 className="mr-2 h-3.5 w-3.5 opacity-60" />
          Manage Agents…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCustomizeToolbar} className="h-7">
          <Settings2 className="mr-2 h-3.5 w-3.5 opacity-60" />
          Customize Toolbar…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LaunchRow({
  row,
  onLaunch,
  onKeyDown,
  onTogglePin,
  stopPointer,
}: {
  row: AgentRow;
  onLaunch: (row: AgentRow) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, row: AgentRow) => void;
  onTogglePin: (row: AgentRow) => void;
  stopPointer: (e: ReactPointerEvent) => void;
}) {
  const displayCombo = useKeybindingDisplay(`agent.${row.id}`);

  return (
    <DropdownMenuItem
      onSelect={() => onLaunch(row)}
      onKeyDown={(e) => onKeyDown(e, row)}
      className="group h-7"
      data-testid={`agent-tray-row-${row.id}`}
    >
      <span className="relative mr-2 inline-flex h-4 w-4 items-center justify-center">
        <row.Icon brandColor={getBrandColorHex(row.id)} />
        <RunningDot state={row.dominantState} />
      </span>

      <span className="flex-1">{row.name}</span>

      {row.isNew && (
        <span
          data-testid={`agent-tray-new-pill-${row.id}`}
          className="ml-2 shrink-0 rounded border border-sky-400/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300"
        >
          New
        </span>
      )}

      {displayCombo && <DropdownMenuShortcut>{displayCombo}</DropdownMenuShortcut>}

      <span className="sr-only">Press P to {row.pinned ? "unpin from" : "pin to"} toolbar</span>

      <span
        role="presentation"
        aria-hidden="true"
        data-testid={`agent-tray-pin-${row.id}`}
        data-pinned={row.pinned ? "true" : "false"}
        title={row.pinned ? "Unpin from toolbar (P)" : "Pin to toolbar (P)"}
        onPointerDown={stopPointer}
        onPointerUp={stopPointer}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(row);
        }}
        className={cn(
          "ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text",
          row.pinned ? "opacity-100" : "opacity-0 group-data-[highlighted]:opacity-100"
        )}
      >
        <Pin
          className={cn("h-3 w-3", row.pinned && "fill-current text-daintree-text")}
          strokeWidth={row.pinned ? 2 : 1.75}
        />
      </span>
    </DropdownMenuItem>
  );
}
