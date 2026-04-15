import { useMemo, type ComponentType } from "react";
import { Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig, type AgentIconProps } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import type { CliAvailability } from "@shared/types";
import { isAgentReady } from "../../../shared/utils/agentAvailability";

interface AgentTrayButtonProps {
  agentAvailability?: CliAvailability;
  "data-toolbar-item"?: string;
}

type AgentRow = {
  id: BuiltInAgentId;
  name: string;
  Icon: ComponentType<AgentIconProps>;
};

function buildAgentRow(id: BuiltInAgentId): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  return { id, name: config.name, Icon: config.icon };
}

export function AgentTrayButton({
  agentAvailability,
  "data-toolbar-item": dataToolbarItem,
}: AgentTrayButtonProps) {
  // Subscribe to the store directly so pin/unpin toggles update the UI
  // immediately without depending on any caller-side refetch.
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);

  const isAvailabilityLoading = agentAvailability === undefined;

  const { readyUnpinned, readyAll, needsSetup } = useMemo(() => {
    const readyUnpinned: AgentRow[] = [];
    const readyAll: AgentRow[] = [];
    const needsSetup: AgentRow[] = [];

    for (const id of BUILT_IN_AGENT_IDS) {
      const row = buildAgentRow(id);
      if (!row) continue;

      const availabilityState = agentAvailability?.[id];
      // Launch is only safe for "ready" (authenticated). "installed" means
      // the CLI binary was found but the agent isn't authenticated, so it
      // belongs in the setup section alongside missing agents.
      const ready = isAgentReady(availabilityState);
      const resolved = availabilityState !== undefined;
      const pinned = agentSettings?.agents?.[id]?.pinned === true;

      if (ready) {
        readyAll.push(row);
        if (!pinned) readyUnpinned.push(row);
      } else if (resolved) {
        needsSetup.push(row);
      }
    }

    return { readyUnpinned, readyAll, needsSetup };
  }, [agentAvailability, agentSettings]);

  const handleLaunch = (agentId: BuiltInAgentId) => {
    void actionService.dispatch("agent.launch", { agentId }, { source: "user" });
  };

  const handleTogglePin = (agentId: BuiltInAgentId, checked: boolean) => {
    void setAgentPinned(agentId, checked);
  };

  const handleSetup = (agentId: BuiltInAgentId) => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: agentId },
      { source: "user" }
    );
  };

  const hasAnyContent = readyUnpinned.length > 0 || readyAll.length > 0 || needsSetup.length > 0;

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                className="toolbar-agent-button text-daintree-text hover:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] focus-visible:text-[var(--toolbar-control-hover-fg,var(--theme-accent-primary))] transition-colors"
                aria-label="Agent tray"
              >
                <Puzzle />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Agent Tray</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[14rem]">
        {!hasAnyContent &&
          (isAvailabilityLoading ? (
            <div className="px-2.5 py-2 text-xs text-daintree-text/60">Checking agents…</div>
          ) : (
            <div className="px-2.5 py-2 text-xs text-daintree-text/60">No agents available</div>
          ))}

        {readyUnpinned.length > 0 && (
          <>
            <DropdownMenuLabel>Launch</DropdownMenuLabel>
            {readyUnpinned.map((row) => (
              <DropdownMenuItem key={`launch-${row.id}`} onSelect={() => handleLaunch(row.id)}>
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                {row.name}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {readyAll.length > 0 && (
          <>
            {readyUnpinned.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>Pin to Toolbar</DropdownMenuLabel>
            {readyAll.map((row) => {
              const pinned = agentSettings?.agents?.[row.id]?.pinned === true;
              return (
                <DropdownMenuCheckboxItem
                  key={`pin-${row.id}`}
                  checked={pinned}
                  onCheckedChange={(checked) => handleTogglePin(row.id, checked === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {row.name}
                </DropdownMenuCheckboxItem>
              );
            })}
          </>
        )}

        {needsSetup.length > 0 && (
          <>
            {(readyUnpinned.length > 0 || readyAll.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuLabel>Needs Setup</DropdownMenuLabel>
            {needsSetup.map((row) => (
              <DropdownMenuItem key={`setup-${row.id}`} onSelect={() => handleSetup(row.id)}>
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center opacity-60">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                <span className="flex-1">{row.name}</span>
                <span className="ml-2 text-[11px] text-daintree-text/60">Set up</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
