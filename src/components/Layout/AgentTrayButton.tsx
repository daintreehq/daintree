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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import { getAgentConfig, type AgentIconProps } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useKeybindingDisplay } from "@/hooks";
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
  dominantState: AgentState | null
): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  return { id, name: config.name, Icon: config.icon, pinned, dominantState };
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

  const panelsById = usePanelStore((s) => s.panelsById);
  const panelIds = usePanelStore((s) => s.panelIds);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const isAvailabilityLoading = agentAvailability === undefined;
  const lastPinActionAt = useRef(0);

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

  const { launchable, needsSetup } = useMemo(() => {
    const launchable: AgentRow[] = [];
    const needsSetup: AgentRow[] = [];

    for (const id of BUILT_IN_AGENT_IDS) {
      const pinned = isAgentPinned(agentSettings?.agents?.[id]);
      const dominant = agentDominantStates.get(id) ?? null;
      const row = buildAgentRow(id, pinned, dominant);
      if (!row) continue;

      const state = agentAvailability?.[id];
      if (isAgentReady(state)) {
        launchable.push(row);
      } else if (isAgentInstalled(state) || state !== undefined) {
        needsSetup.push(row);
      }
    }

    return { launchable, needsSetup };
  }, [agentAvailability, agentSettings, agentDominantStates]);

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
        onCloseAutoFocus={(e) => {
          if ((e as unknown as PointerEvent).detail > 0) e.preventDefault();
        }}
      >
        {!hasAnyContent &&
          (isAvailabilityLoading ? (
            <div className="px-2.5 py-1.5 text-xs text-daintree-text/60">Checking agents…</div>
          ) : (
            <div className="px-2.5 py-1.5 text-xs text-daintree-text/60">No agents available</div>
          ))}

        {launchable.length > 0 && (
          <>
            <DropdownMenuLabel>Agents</DropdownMenuLabel>
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
            <DropdownMenuLabel>Also Available</DropdownMenuLabel>
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

        {hasAnyContent && <DropdownMenuSeparator />}
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
