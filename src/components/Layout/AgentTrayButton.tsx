import {
  useMemo,
  useRef,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig, type AgentIconProps } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import type { CliAvailability } from "@shared/types";
import { isAgentReady, isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
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
};

function buildAgentRow(id: BuiltInAgentId, pinned: boolean): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  return { id, name: config.name, Icon: config.icon, pinned };
}

export function AgentTrayButton({
  agentAvailability,
  "data-toolbar-item": dataToolbarItem,
}: AgentTrayButtonProps) {
  // Subscribe directly so pin/unpin toggles update instantly without
  // waiting for caller-side refetches.
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);

  const isAvailabilityLoading = agentAvailability === undefined;
  const lastPinActionAt = useRef(0);

  const { launchable, needsSetup } = useMemo(() => {
    const launchable: AgentRow[] = [];
    const needsSetup: AgentRow[] = [];

    for (const id of BUILT_IN_AGENT_IDS) {
      const pinned = isAgentPinned(agentSettings?.agents?.[id]);
      const row = buildAgentRow(id, pinned);
      if (!row) continue;

      const state = agentAvailability?.[id];
      if (isAgentReady(state)) {
        // Ready agents all live in a single Launch list, pinned or not.
        launchable.push(row);
      } else if (isAgentInstalled(state) || state !== undefined) {
        // installed-but-unauth and missing both route to setup.
        needsSetup.push(row);
      }
    }

    return { launchable, needsSetup };
  }, [agentAvailability, agentSettings]);

  const handleLaunch = (agentId: BuiltInAgentId) => {
    void actionService.dispatch("agent.launch", { agentId }, { source: "user" });
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

  const togglePin = (row: AgentRow) => {
    // Pointerdown + click fire for the same physical tap — dedupe them.
    const now = Date.now();
    if (now - lastPinActionAt.current < 50) return;
    lastPinActionAt.current = now;

    void setAgentPinned(row.id, !row.pinned);
  };

  // Radix DropdownMenu auto-closes on menuitem select. Stopping pointer
  // events on the trailing pin prevents the row's onSelect from firing,
  // keeping the menu open for batch pin/unpin.
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
                <Plug />
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
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {!hasAnyContent &&
          (isAvailabilityLoading ? (
            <div className="px-2.5 py-2 text-xs text-daintree-text/60">Checking agents…</div>
          ) : (
            <div className="px-2.5 py-2 text-xs text-daintree-text/60">No agents available</div>
          ))}

        {launchable.length > 0 && (
          <>
            <DropdownMenuLabel>Launch</DropdownMenuLabel>
            {launchable.map((row) => (
              <DropdownMenuItem
                key={`launch-${row.id}`}
                onSelect={() => handleLaunch(row.id)}
                onKeyDown={(e) => handleRowKeyDown(e, row)}
                className="group"
              >
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                <span className="flex-1">{row.name}</span>
                <span className="sr-only">
                  Press P to {row.pinned ? "unpin from" : "pin to"} toolbar
                </span>
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
                    togglePin(row);
                  }}
                  className={cn(
                    "ml-2 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/60 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text",
                    row.pinned
                      ? "opacity-100 text-daintree-text"
                      : "opacity-0 group-hover:opacity-100 group-focus:opacity-100 group-data-[highlighted]:opacity-100"
                  )}
                >
                  <Pin
                    className={cn("h-3.5 w-3.5", row.pinned && "fill-current")}
                    strokeWidth={row.pinned ? 2 : 1.75}
                  />
                </span>
              </DropdownMenuItem>
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
                className="group"
              >
                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center opacity-60">
                  <row.Icon brandColor={getBrandColorHex(row.id)} />
                </span>
                <span className="flex-1">{row.name}</span>
                <span className="ml-2 text-[11px] text-daintree-text/60">Set up</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {hasAnyContent && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={handleCustomizeToolbar}>
          <Settings2 className="mr-2 h-3.5 w-3.5 opacity-70" />
          Customize Toolbar…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
