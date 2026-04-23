import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plug, Pin, Settings2, ChevronRight } from "lucide-react";
import { DaintreeAgentIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import {
  getAgentConfig,
  getMergedPresets,
  type AgentIconProps,
  type AgentPreset,
} from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useActionMruStore } from "@/store/actionMruStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
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
  presets?: AgentPreset[];
  projectPresetIds: Set<string>;
};

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

function buildAgentRow(
  id: BuiltInAgentId,
  pinned: boolean,
  dominantState: AgentState | null,
  isNew: boolean,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  const presets = getMergedPresets(id, customPresets, ccrPresets, projectPresets);
  const hasPresets = presets.length > 1;
  return {
    id,
    name: config.name,
    Icon: config.icon,
    pinned,
    dominantState,
    isNew,
    presets: hasPresets ? presets : undefined,
    projectPresetIds: new Set((projectPresets ?? []).map((f) => f.id)),
  };
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

type SplitLaunchItemProps = {
  row: AgentRow;
  onLaunch: (agentId: BuiltInAgentId, presetId?: string | null) => void;
};

function SplitLaunchItem({ row, onLaunch }: SplitLaunchItemProps) {
  const leftAreaRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = leftAreaRef.current;
    if (!el) return;
    const handler = (e: PointerEvent) => {
      // Prevent Radix from opening the submenu when clicking the main area
      e.stopPropagation();
      e.preventDefault();
      onLaunch(row.id, null);
    };
    el.addEventListener("pointerdown", handler, true);
    return () => el.removeEventListener("pointerdown", handler, true);
  }, [row.id, onLaunch]);

  // Keyboard: Enter/Space on the SubTrigger must launch default (primary action)
  // rather than Radix's default of opening the submenu. ArrowRight still opens
  // the submenu for picking a specific preset. Without this, keyboard users
  // cannot trigger the left-side default launch at all.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onLaunch(row.id, null);
    }
  };

  // Project membership beats the ccr- prefix so a project preset with a
  // ccr-* id still lands under "Project Shared". Everything not-ccr and
  // not-project falls through to "Custom" — preserves historical display
  // for presets whose provenance can't be determined from id alone.
  const projectPresets = (row.presets ?? []).filter((f) => row.projectPresetIds.has(f.id));
  const ccrPresets = (row.presets ?? []).filter(
    (f) => !row.projectPresetIds.has(f.id) && f.id.startsWith("ccr-")
  );
  const customPresets = (row.presets ?? []).filter(
    (f) => !row.projectPresetIds.has(f.id) && !f.id.startsWith("ccr-")
  );
  const groupCount =
    (ccrPresets.length > 0 ? 1 : 0) +
    (projectPresets.length > 0 ? 1 : 0) +
    (customPresets.length > 0 ? 1 : 0);
  const hasMultipleGroups = groupCount > 1;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="p-0 [&>svg:last-child]:hidden overflow-hidden"
        data-testid="submenu-trigger"
        onKeyDown={handleKeyDown}
        aria-label={`${row.name} (press Enter to launch, Right Arrow for presets)`}
      >
        <span ref={leftAreaRef} className="flex flex-1 items-center gap-2 px-2.5 py-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center shrink-0">
            <row.Icon brandColor={getBrandColorHex(row.id)} />
          </span>
          {row.name}
        </span>
        <span
          className="flex items-center px-2 py-1.5 border-l border-daintree-border/50"
          aria-hidden="true"
        >
          <ChevronRight className="h-3.5 w-3.5 text-daintree-text/40" />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-testid="submenu-content">
        <DropdownMenuItem onSelect={() => onLaunch(row.id, null)}>
          <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
            <row.Icon brandColor={getBrandColorHex(row.id)} />
          </span>
          Default
        </DropdownMenuItem>
        {ccrPresets.length > 0 && (
          <>
            {hasMultipleGroups && <DropdownMenuSeparator />}
            {hasMultipleGroups && <DropdownMenuLabel>CCR Routes</DropdownMenuLabel>}
            {ccrPresets.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => onLaunch(row.id, preset.id)}>
                <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                  <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                </span>
                {preset.name.replace(/^CCR:\s*/, "")}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {projectPresets.length > 0 && (
          <>
            {hasMultipleGroups && <DropdownMenuSeparator />}
            {hasMultipleGroups && <DropdownMenuLabel>Project Shared</DropdownMenuLabel>}
            {projectPresets.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => onLaunch(row.id, preset.id)}>
                <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                  <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                </span>
                {preset.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {customPresets.length > 0 && (
          <>
            {hasMultipleGroups && <DropdownMenuSeparator />}
            {hasMultipleGroups && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
            {customPresets.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => onLaunch(row.id, preset.id)}>
                <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                  <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                </span>
                {preset.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function AgentTrayButton({
  agentAvailability,
  "data-toolbar-item": dataToolbarItem,
}: AgentTrayButtonProps) {
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const updateWorktreePreset = useAgentSettingsStore((s) => s.updateWorktreePreset);

  const getSortedActionMruList = useActionMruStore(useShallow((s) => s.getSortedActionMruList));

  const refreshAvailability = useCliAvailabilityStore((s) => s.refresh);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const {
    loaded: onboardingLoaded,
    seenAgentIds,
    welcomeCardDismissed,
    markAgentsSeen,
  } = useAgentDiscoveryOnboarding();

  const [open, setOpen] = useState(false);

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
      // Launch-intent only: the tray aggregates sessions by the agent they were
      // launched as, so pre-detection panels still appear under their tray entry.
      // Using `isRuntimeAgentTerminal` here would silently exclude freshly-spawned
      // agents during the boot window and demote ex-agents that outlived their
      // process — neither matches the tray's "sessions grouped by launch agent" model.
      if (!p || !p.agentId || p.location === "trash" || p.location === "background") continue;
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
      const customPresets = agentSettings?.agents?.[id]?.customPresets;
      const ccrPresets = ccrPresetsByAgent[id];
      const projectPresets = projectPresetsByAgent[id];
      const row = buildAgentRow(
        id,
        pinned,
        dominant,
        newAgentIds.has(id),
        customPresets,
        ccrPresets,
        projectPresets
      );
      if (!row) continue;

      const state = agentAvailability?.[id];
      if (isAgentReady(state)) {
        // Launchable. Passive auth discovery (`authConfirmed: false`) never
        // moves an agent out of Launch — clicking starts the CLI, which
        // prompts for sign-in on first run. The decoupling goal of
        // #5483 requires this path to stay hot.
        launchable.push(row);
      } else if (isAgentInstalled(state)) {
        // Reached only for the WSL `installed` cap (direct launch isn't
        // wired through wsl.exe yet) and any future non-launchable
        // installed state. These belong in "Needs Setup" — routing to
        // Settings gives the user actionable install docs.
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
  }, [
    agentAvailability,
    agentSettings,
    agentDominantStates,
    getSortedActionMruList,
    newAgentIds,
    ccrPresetsByAgent,
    projectPresetsByAgent,
  ]);

  const handleLaunch = useCallback(
    (agentId: BuiltInAgentId, presetId?: string | null) => {
      setOpen(false);
      // Persist the pick to the worktree-scoped slot so a subsequent main-
      // button press on this worktree relaunches the same preset while other
      // worktrees keep their own. `null` clears the scoped override (and
      // dispatches with presetId: null to force a preset-free launch);
      // `undefined` is the plain MRU fall-through and writes nothing.
      if (activeWorktreeId && presetId !== undefined) {
        void updateWorktreePreset(agentId, activeWorktreeId, presetId ?? undefined);
      }
      void actionService.dispatch(
        "agent.launch",
        { agentId, ...(presetId !== undefined ? { presetId } : {}) },
        { source: "user" }
      );
    },
    [activeWorktreeId, updateWorktreePreset]
  );

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

  const handleOpenAgentSetupWizard = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
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

  const renderLaunchItem = (row: AgentRow) => {
    if (row.presets && row.presets.length > 0) {
      return <SplitLaunchItem key={`launch-${row.id}`} row={row} onLaunch={handleLaunch} />;
    }

    return (
      <LaunchRow
        key={`launch-${row.id}`}
        row={row}
        onLaunch={handleLaunch}
        onKeyDown={handleRowKeyDown}
        onTogglePin={togglePin}
        stopPointer={stopPointer}
      />
    );
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        handleOpenChange(o);
      }}
    >
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
                      className="absolute top-0 right-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
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
            {launchable.map((row) => renderLaunchItem(row))}
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
          Manage Agents
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCustomizeToolbar} className="h-7">
          <Settings2 className="mr-2 h-3.5 w-3.5 opacity-60" />
          Customize Toolbar
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenAgentSetupWizard} className="h-7">
          <DaintreeAgentIcon className="mr-2 h-3.5 w-3.5" />
          Set Up Agents
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
  onLaunch: (agentId: BuiltInAgentId, presetId?: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, row: AgentRow) => void;
  onTogglePin: (row: AgentRow) => void;
  stopPointer: (e: ReactPointerEvent) => void;
}) {
  const displayCombo = useKeybindingDisplay(`agent.${row.id}`);

  return (
    <DropdownMenuItem
      onSelect={() => onLaunch(row.id)}
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
          className="ml-2 shrink-0 rounded border border-status-info/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-status-info"
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
