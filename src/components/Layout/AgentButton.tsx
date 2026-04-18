import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig, getMergedFlavors } from "@/config/agents";
import { useKeybindingDisplay } from "@/hooks";
import { useWorktrees } from "@/hooks/useWorktrees";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ChevronDown, Unplug } from "lucide-react";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentAvailabilityState, AgentState } from "@shared/types";
import { isAgentReady, isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrFlavorsStore } from "@/store/ccrFlavorsStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useShallow } from "zustand/react/shallow";
import {
  getDominantAgentState,
  agentStateDotColor,
} from "@/components/Worktree/AgentStatusIndicator";

type AgentType = BuiltInAgentId;

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "running",
  "waiting",
  "directing",
]);

interface AgentButtonProps {
  type: AgentType;
  availability?: AgentAvailabilityState;
  "data-toolbar-item"?: string;
}

export function AgentButton({
  type,
  availability,
  "data-toolbar-item": dataToolbarItem,
}: AgentButtonProps) {
  const { worktrees } = useWorktrees();
  const displayCombo = useKeybindingDisplay(`agent.${type}`);
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const ccrFlavors = useCcrFlavorsStore((s) => s.ccrFlavorsByAgent[type]);

  const panelsById = usePanelStore(useShallow((s) => s.panelsById));
  const panelIds = usePanelStore(useShallow((s) => s.panelIds));
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const activeSession = useMemo(() => {
    const states: (AgentState | undefined)[] = [];
    let firstId: string | null = null;
    for (const pid of panelIds) {
      const p = panelsById[pid];
      if (
        !p ||
        p.kind !== "agent" ||
        p.agentId !== type ||
        p.location === "trash" ||
        p.location === "background"
      )
        continue;
      if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
      if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
      if (!firstId) firstId = pid;
      states.push(p.agentState);
    }
    if (!firstId) return null;
    return { id: firstId, dominantState: getDominantAgentState(states) };
  }, [panelsById, panelIds, activeWorktreeId, type]);

  const config = getAgentConfig(type);
  if (!config) return null;

  const isSessionActive = activeSession !== null;
  const dominantState = activeSession?.dominantState ?? null;

  const entry = agentSettings?.agents?.[type] ?? {};
  const flavors = getMergedFlavors(type, entry.customFlavors, ccrFlavors);
  // Only show the split/chevron UI when there are at least 2 flavors; a single
  // flavor is implicitly the default and doesn't warrant a picker.
  const hasFlavors = flavors.length >= 2;
  const savedFlavorId = agentSettings?.agents?.[type]?.flavorId;
  const ccrFlavorGroup = flavors.filter((f) => f.id.startsWith("ccr-"));
  const customFlavorGroup = flavors.filter((f) => !f.id.startsWith("ccr-"));
  const hasBothFlavorGroups = ccrFlavorGroup.length > 0 && customFlavorGroup.length > 0;

  const tooltipDetails = config.tooltip ? ` — ${config.tooltip}` : "";
  const shortcut = displayCombo ? ` (${displayCombo})` : "";
  const isLoading = availability === undefined;
  const isReady = isAgentReady(availability);
  const isInstalledOnly = isAgentInstalled(availability);
  const needsSetup = isInstalledOnly && !isReady;

  const tooltip = isLoading
    ? `Checking ${config.name} CLI availability...`
    : isReady
      ? `Start ${config.name}${tooltipDetails}${shortcut}`
      : needsSetup
        ? `${config.name} needs setup. Click to configure.`
        : `${config.name} CLI not found. Click to install.`;

  const ariaLabel = isLoading
    ? `Checking ${config.name} availability`
    : isReady
      ? `Start ${config.name} Agent`
      : needsSetup
        ? `${config.name} needs setup`
        : `${config.name} CLI not installed`;

  const handleClick = () => {
    if (isReady) {
      // MRU semantics: primary-button click launches with the saved flavor if
      // one is stored (user's last pick), otherwise vanilla (no flavorId).
      // Passing `flavorId: null` would force explicit vanilla and override a
      // saved default — we want undefined fallthrough to useAgentLauncher.
      void actionService.dispatch(
        "agent.launch",
        savedFlavorId ? { agentId: type, flavorId: savedFlavorId } : { agentId: type },
        { source: "user" }
      );
    } else {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "agents", subtab: type },
        { source: "user" }
      );
    }
  };

  const handleUnpinFromToolbar = () => {
    void useAgentSettingsStore.getState().setAgentPinned(type, false);
  };

  const iconElement = (
    <div className="relative">
      <config.icon brandColor={getBrandColorHex(type)} />
      {isSessionActive && dominantState && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-daintree-sidebar",
            agentStateDotColor(dominantState)
          )}
          aria-hidden="true"
        />
      )}
    </div>
  );

  if (!hasFlavors) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleClick}
                    disabled={isLoading}
                    data-toolbar-item={dataToolbarItem}
                    className={cn(
                      "toolbar-agent-button text-daintree-text transition-colors",
                      isReady &&
                        "hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] focus-visible:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]",
                      needsSetup && "opacity-70"
                    )}
                    aria-label={ariaLabel}
                  >
                    {iconElement}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={!isReady}
            onSelect={() =>
              void actionService.dispatch(
                "agent.launch",
                { agentId: type },
                { source: "context-menu" }
              )
            }
          >
            Launch {config.name}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!isReady}
            onSelect={() =>
              void actionService.dispatch(
                "agent.launch",
                { agentId: type, location: "dock" },
                { source: "context-menu" }
              )
            }
          >
            Launch {config.name} in Dock
          </ContextMenuItem>
          {worktrees.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={!isReady}>Launch in Worktree</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {worktrees.map((wt) => {
                  const label = wt.isMainWorktree ? wt.name : wt.branch?.trim() || wt.name;
                  return (
                    <ContextMenuSub key={wt.id}>
                      <ContextMenuSubTrigger>{label}</ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        <ContextMenuItem
                          onSelect={() =>
                            void actionService.dispatch(
                              "agent.launch",
                              { agentId: type, worktreeId: wt.id, location: "grid" },
                              { source: "context-menu" }
                            )
                          }
                        >
                          Grid
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() =>
                            void actionService.dispatch(
                              "agent.launch",
                              { agentId: type, worktreeId: wt.id, location: "dock" },
                              { source: "context-menu" }
                            )
                          }
                        >
                          Dock
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  );
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleUnpinFromToolbar}>
            <Unplug className="mr-2 h-3.5 w-3.5" />
            Unpin from Toolbar
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "agents", subtab: type },
                { source: "context-menu" }
              )
            }
          >
            {config.name} Settings...
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClick}
                  disabled={isLoading}
                  data-toolbar-item={dataToolbarItem}
                  className={cn(
                    "toolbar-agent-button text-daintree-text transition-colors rounded-r-none border-r border-transparent",
                    isReady &&
                      "hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] focus-visible:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]",
                    needsSetup && "opacity-70"
                  )}
                  aria-label={ariaLabel}
                >
                  {iconElement}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      disabled={isLoading || !isReady}
                      data-toolbar-item={dataToolbarItem}
                      className={cn(
                        "toolbar-agent-button text-daintree-text transition-colors rounded-l-none",
                        "h-8 w-4 p-0 flex items-center justify-center",
                        "hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] focus-visible:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))]",
                        !isReady && !isLoading && "opacity-60"
                      )}
                      aria-label={`Choose ${config.name} flavor`}
                    >
                      <ChevronDown className="h-3 w-3 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" sideOffset={4} className="min-w-[12rem]">
                    <DropdownMenuItem
                      className={cn(!savedFlavorId && "font-medium")}
                      onSelect={() => {
                        void actionService.dispatch(
                          "agent.launch",
                          { agentId: type, flavorId: null },
                          { source: "user" }
                        );
                      }}
                    >
                      <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                        <config.icon brandColor={getBrandColorHex(type)} />
                      </span>
                      Vanilla
                    </DropdownMenuItem>
                    {ccrFlavorGroup.length > 0 && (
                      <>
                        {hasBothFlavorGroups && <DropdownMenuSeparator />}
                        {hasBothFlavorGroups && <DropdownMenuLabel>CCR Routes</DropdownMenuLabel>}
                        {ccrFlavorGroup.map((flavor) => (
                          <DropdownMenuItem
                            key={flavor.id}
                            className={cn(savedFlavorId === flavor.id && "font-medium")}
                            onSelect={() => {
                              void actionService.dispatch(
                                "agent.launch",
                                { agentId: type, flavorId: flavor.id },
                                { source: "user" }
                              );
                            }}
                          >
                            <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                              <config.icon brandColor={flavor.color ?? getBrandColorHex(type)} />
                            </span>
                            {flavor.name.replace(/^CCR:\s*/, "")}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {customFlavorGroup.length > 0 && (
                      <>
                        {hasBothFlavorGroups && <DropdownMenuSeparator />}
                        {hasBothFlavorGroups && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
                        {customFlavorGroup.map((flavor) => (
                          <DropdownMenuItem
                            key={flavor.id}
                            className={cn(savedFlavorId === flavor.id && "font-medium")}
                            onSelect={() => {
                              void actionService.dispatch(
                                "agent.launch",
                                { agentId: type, flavorId: flavor.id },
                                { source: "user" }
                              );
                            }}
                          >
                            <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                              <config.icon brandColor={flavor.color ?? getBrandColorHex(type)} />
                            </span>
                            {flavor.name}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!isReady}
          onSelect={() =>
            void actionService.dispatch(
              "agent.launch",
              { agentId: type },
              { source: "context-menu" }
            )
          }
        >
          Launch {config.name}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!isReady}
          onSelect={() =>
            void actionService.dispatch(
              "agent.launch",
              { agentId: type, location: "dock" },
              { source: "context-menu" }
            )
          }
        >
          Launch {config.name} in Dock
        </ContextMenuItem>
        {hasFlavors && (
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!isReady}>Launch with Flavor</ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="context-submenu-content">
              {flavors.map((flavor) => (
                <ContextMenuItem
                  key={flavor.id}
                  onSelect={() =>
                    void actionService.dispatch(
                      "agent.launch",
                      { agentId: type, flavorId: flavor.id },
                      { source: "context-menu" }
                    )
                  }
                >
                  {flavor.name}
                  {savedFlavorId === flavor.id ? " ✓" : ""}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {worktrees.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!isReady}>Launch in Worktree</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {worktrees.map((wt) => {
                const label = wt.isMainWorktree ? wt.name : wt.branch?.trim() || wt.name;
                return (
                  <ContextMenuSub key={wt.id}>
                    <ContextMenuSubTrigger>{label}</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem
                        onSelect={() =>
                          void actionService.dispatch(
                            "agent.launch",
                            { agentId: type, worktreeId: wt.id, location: "grid" },
                            { source: "context-menu" }
                          )
                        }
                      >
                        Grid
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() =>
                          void actionService.dispatch(
                            "agent.launch",
                            { agentId: type, worktreeId: wt.id, location: "dock" },
                            { source: "context-menu" }
                          )
                        }
                      >
                        Dock
                      </ContextMenuItem>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleUnpinFromToolbar}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Unpin from Toolbar
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "agents", subtab: type },
              { source: "context-menu" }
            )
          }
        >
          {config.name} Settings...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
