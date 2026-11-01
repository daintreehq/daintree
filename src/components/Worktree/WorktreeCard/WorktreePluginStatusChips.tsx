import { useEffect, useSyncExternalStore, type MouseEvent } from "react";
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
  usePluginWorktreeCardStatusStore,
  worktreeCardStatusesFor,
  type WorktreeCardPluginStatus,
} from "@/store/pluginWorktreeCardStatusStore";
import type { ActionId } from "@shared/types/actions";
import type { PluginWorktreeCardStatus } from "@shared/types/plugin";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { FocusHandoffGuard } from "../FocusHandoffGuard";

interface PluginStatusChipProps {
  pluginId: string;
  worktreeId: string;
  status: PluginWorktreeCardStatus;
  registeredActions: ReadonlyMap<string, string>;
  tabIndex?: number;
  onBeforeRun?: () => void;
}

function PluginStatusChip({
  pluginId,
  worktreeId,
  status,
  registeredActions,
  tabIndex,
  onBeforeRun,
}: PluginStatusChipProps) {
  const { name } = usePluginAttribution(pluginId);
  // Runs only the plugin's own action, and only while it is registered; until
  // then the chip is the plain status it always was (#13776).
  const command =
    status.command !== undefined && isOwnPluginAction(pluginId, status.command)
      ? status.command
      : undefined;
  const actionTitle = command !== undefined ? registeredActions.get(command) : undefined;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A press (or Enter/Space, which click it) must never reach the card and
    // select the worktree, whether or not the chip runs anything.
    event.stopPropagation();
    if (command === undefined || actionTitle === undefined) return;
    onBeforeRun?.();
    void actionService.dispatch(command as ActionId, { worktreeId }, { source: "user" });
  };

  return (
    // A plugin's explanation can run to several lines, so it stays while
    // hovered or focused and can be hovered itself (WCAG 1.4.13).
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>
        {/* A button so the status is reachable by keyboard and its tooltip
            opens on focus, even when it has no command to run. */}
        <button
          type="button"
          data-no-dnd
          tabIndex={tabIndex}
          aria-label={`${name}: ${status.label}`}
          onClick={handleClick}
          className={cn(
            // A quiet chip, so a plugin's word reads as a mark on the card
            // rather than a stray line of body copy, on a 24px target.
            "inline-flex h-6 min-w-0 max-w-full items-center rounded-[var(--radius-sm)] border border-border-default bg-overlay-subtle px-1.5 text-2xs text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            actionTitle !== undefined &&
              "cursor-pointer transition-colors duration-150 ease-out hover:bg-overlay-soft hover:text-text-primary"
          )}
        >
          <span className="min-w-0 truncate">{status.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="flex flex-col gap-1">
          <span>{`${name} · ${status.label}`}</span>
          {status.tooltip && (
            <span className="whitespace-pre-wrap break-words text-text-secondary">
              {status.tooltip}
            </span>
          )}
          {actionTitle !== undefined && (
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
 * Every plugin's status on one worktree's card, in its chip order. Reads only
 * the current project's statuses, and subscribes the store on first use.
 */
export function useWorktreePluginStatuses(worktreeId: string): WorktreeCardPluginStatus[] {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const byPlugin = usePluginWorktreeCardStatusStore((s) =>
    projectId ? s.statusesByProject[projectId] : undefined
  );
  useEffect(() => {
    usePluginWorktreeCardStatusStore.getState().init();
  }, []);
  return worktreeCardStatusesFor(byPlugin, worktreeId);
}

/**
 * The statuses plugins put on this worktree's card (#13704): one quiet chip per
 * plugin, each named after its plugin, so two plugins marking the same card
 * never hide each other. Drawn like the attachment chips. A chip whose status
 * names a registered command of its plugin runs it with `{ worktreeId }` when
 * clicked (#13776). The overview passes `tabIndex={-1}` (F2 reaches its row's
 * controls), `onBeforeRun` to get out of the way as a command starts, as its
 * context-menu actions do, and `onFocusLost` for a focused chip that goes.
 */
export function WorktreePluginStatusChips({
  worktreeId,
  statuses,
  tabIndex,
  onBeforeRun,
  onFocusLost,
}: {
  worktreeId: string;
  statuses: readonly WorktreeCardPluginStatus[];
  tabIndex?: number;
  onBeforeRun?: () => void;
  onFocusLost?: () => void;
}) {
  // Subscribed, not read from ActionService: a command registering after its
  // status arrived must still make the chip clickable.
  const registeredActions = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );
  if (statuses.length === 0) return null;
  return (
    <>
      {statuses.map(({ pluginId, status }) => {
        const chip = (
          <PluginStatusChip
            key={pluginId}
            pluginId={pluginId}
            worktreeId={worktreeId}
            status={status}
            registeredActions={registeredActions}
            tabIndex={tabIndex}
            onBeforeRun={onBeforeRun}
          />
        );
        // Each chip guarded on its own: one plugin clearing its status while
        // its chip has focus must hand the keyboard back, even as others stay.
        return onFocusLost ? (
          <FocusHandoffGuard key={pluginId} onFocusLeaving={onFocusLost}>
            {chip}
          </FocusHandoffGuard>
        ) : (
          chip
        );
      })}
    </>
  );
}
