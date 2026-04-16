import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig } from "@/config/agents";
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

import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentAvailabilityState } from "@shared/types";
import { isAgentReady, isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { Unplug } from "lucide-react";

type AgentType = BuiltInAgentId;

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

  const config = getAgentConfig(type);
  if (!config) return null;

  const tooltipDetails = config.tooltip ? ` — ${config.tooltip}` : "";
  const shortcut = displayCombo ? ` (${displayCombo})` : "";
  const isLoading = availability === undefined;
  const isReady = isAgentReady(availability);
  const isInstalled = isAgentInstalled(availability);
  const needsSetup = isInstalled && !isReady;

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
      void actionService.dispatch("agent.launch", { agentId: type }, { source: "user" });
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
                  <config.icon brandColor={getBrandColorHex(type)} />
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
