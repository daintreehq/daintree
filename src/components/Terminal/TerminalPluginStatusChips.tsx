import { useEffect, useMemo, useSyncExternalStore, type MouseEvent } from "react";
import { isOwnPluginAction } from "@shared/utils/remotePluginContributions";
import { cn } from "@/lib/utils";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { actionService } from "@/services/ActionService";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import { useProjectStore } from "@/store/projectStore";
import {
  usePluginTerminalStatusStore,
  terminalStatusesFor,
  type TerminalPluginStatus,
} from "@/store/pluginTerminalStatusStore";
import type { ActionId } from "@shared/types/actions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
} from "./terminalHeaderChip";

interface ChipProps extends TerminalPluginStatus {
  terminalId: string;
  worktreeId?: string;
  registeredActions: ReadonlyMap<string, string>;
}

function PluginTerminalStatusChip({
  pluginId,
  status,
  terminalId,
  worktreeId,
  registeredActions,
}: ChipProps) {
  const { name } = usePluginAttribution(pluginId);
  // Runs only the plugin's own action, and only while it is registered; until
  // then the chip is the plain status it always was.
  const command =
    status.command !== undefined && isOwnPluginAction(pluginId, status.command)
      ? status.command
      : undefined;
  const actionTitle = command !== undefined ? registeredActions.get(command) : undefined;
  const runnable = command !== undefined && actionTitle !== undefined;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Never reaches the header (focus, drag, double-click maximise).
    event.stopPropagation();
    if (!runnable) return;
    void actionService.dispatch(
      command as ActionId,
      worktreeId !== undefined ? { terminalId, worktreeId } : { terminalId },
      { source: "user" }
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A button so the status is reachable by keyboard and its tooltip
            opens on focus, even when it has no command to run. */}
        <button
          type="button"
          data-no-dnd
          aria-label={`${name}: ${status.label}`}
          onClick={handleClick}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "min-w-0 max-w-[140px] shrink select-none",
            runnable
              ? cn(HEADER_CHIP_TRIGGER_CLASS, "cursor-pointer hover:text-text-primary")
              : "cursor-default"
          )}
        >
          <span className="min-w-0 truncate">{status.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-1">
          <span>{`${name} · ${status.label}`}</span>
          {status.tooltip && (
            <span className="whitespace-pre-wrap break-words text-text-secondary">
              {status.tooltip}
            </span>
          )}
          {runnable && (
            <span className="text-text-secondary">
              {actionTitle.length > 0 ? `Click: ${actionTitle}` : "Click to run"}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The statuses plugins put on this terminal's header (#13802): one colourless
 * chip per plugin, each named after its plugin, so the pane's accent and glyphs
 * stay with agent state. Reads only the current project's statuses. A chip
 * whose status names a registered command of its plugin runs it with
 * `{ terminalId, worktreeId? }` when clicked.
 */
export function TerminalPluginStatusChips({
  terminalId,
  worktreeId,
}: {
  terminalId: string;
  worktreeId?: string;
}) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const byPlugin = usePluginTerminalStatusStore((s) =>
    projectId ? s.statusesByProject[projectId] : undefined
  );
  useEffect(() => {
    usePluginTerminalStatusStore.getState().init();
  }, []);
  // Subscribed, not read from ActionService: a command registering after its
  // status arrived must still make the chip clickable.
  const registeredActions = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );
  const statuses = useMemo(() => terminalStatusesFor(byPlugin, terminalId), [byPlugin, terminalId]);
  if (statuses.length === 0) return null;
  return (
    <>
      {statuses.map(({ pluginId, status }) => (
        <PluginTerminalStatusChip
          key={pluginId}
          pluginId={pluginId}
          status={status}
          terminalId={terminalId}
          worktreeId={worktreeId}
          registeredActions={registeredActions}
        />
      ))}
    </>
  );
}
