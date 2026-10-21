import { useEffect } from "react";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { useProjectStore } from "@/store/projectStore";
import {
  usePluginWorktreeCardStatusStore,
  worktreeCardStatusesFor,
  type WorktreeCardPluginStatus,
} from "@/store/pluginWorktreeCardStatusStore";
import type { PluginWorktreeCardStatus } from "@shared/types/plugin";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

function PluginStatusChip({
  pluginId,
  status,
}: {
  pluginId: string;
  status: PluginWorktreeCardStatus;
}) {
  const { name } = usePluginAttribution(pluginId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A button so the status is reachable by keyboard and its tooltip
            opens on focus; it does nothing else, so a press (or Enter/Space,
            which click it) must not reach the card and select the worktree. */}
        <button
          type="button"
          data-no-dnd
          aria-label={`${name}: ${status.label}`}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-6 min-w-0 max-w-full items-center rounded-[var(--radius-sm)] px-1 text-xs text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
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
 * never hide each other. Read-only, and drawn like the attachment chips.
 */
export function WorktreePluginStatusChips({
  statuses,
}: {
  statuses: readonly WorktreeCardPluginStatus[];
}) {
  if (statuses.length === 0) return null;
  return (
    <>
      {statuses.map(({ pluginId, status }) => (
        <PluginStatusChip key={pluginId} pluginId={pluginId} status={status} />
      ))}
    </>
  );
}
