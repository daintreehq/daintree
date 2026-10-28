import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { closeAndAnnounce } from "@/lib/accessibility";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";

/**
 * A worktree's preset pick that just moved off a preset live panes are still
 * on (#13746). Raised by the pick itself, never by state found later: running
 * two presets side by side in one worktree is a legitimate setup, so there is
 * no standing warning.
 */
export interface PresetSwitchNoticeState {
  worktreeId: string;
  /** The worktree's effective preset before the pick; absent is the agent default. */
  fromPresetId: string | undefined;
  fromName: string;
  toPresetId: string;
  toName: string;
}

/**
 * Panes the switch left behind: this agent, this worktree, the preset the pick
 * moved off, and still running. A pane on a fallback carries its own indicator
 * and stays out of it.
 */
export function isPaneLeftOnPreset(
  panel: PanelInstance | undefined,
  agentId: string,
  notice: Pick<PresetSwitchNoticeState, "worktreeId" | "fromPresetId">
): boolean {
  if (!panel || !isPtyPanel(panel)) return false;
  return (
    panel.launchAgentId === agentId &&
    panel.worktreeId === notice.worktreeId &&
    panel.agentPresetId === notice.fromPresetId &&
    !panel.isUsingFallback &&
    !panel.isRestarting &&
    !panel.restoreRecovery &&
    panel.location !== "trash" &&
    panel.agentState !== "exited" &&
    panel.exitCode === undefined
  );
}

export function usePanesLeftOnPreset(
  agentId: string,
  notice: PresetSwitchNoticeState | null
): string[] {
  return usePanelStore(
    useShallow((state) => {
      if (!notice) return [];
      const ids = state.panelIdsByWorktreeId[notice.worktreeId] ?? [];
      return ids.filter((id) => isPaneLeftOnPreset(state.panelsById[id], agentId, notice));
    })
  );
}

/** Rows for the bottom of the preset picker: what was left behind, Restart and Keep. */
export function PresetSwitchNoticeItems({
  agentName,
  notice,
  paneIds,
  onRestart,
  onKeep,
}: {
  agentName: string;
  notice: PresetSwitchNoticeState;
  paneIds: readonly string[];
  onRestart: () => void;
  onKeep: () => void;
}) {
  if (paneIds.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <div role="status" className="px-2 py-1.5 text-xs text-text-secondary">
        {pluralize(paneIds.length, `${agentName} pane`)} still on {notice.fromName}
      </div>
      <DropdownMenuItem inset onSelect={onRestart}>
        {paneIds.length === 1 ? "Restart it" : "Restart them"} on {notice.toName}…
      </DropdownMenuItem>
      <DropdownMenuItem
        inset
        onSelect={(event) => {
          // Keeps the picker open: dismissing the offer isn't a choice of preset.
          event.preventDefault();
          onKeep();
        }}
      >
        Keep
      </DropdownMenuItem>
    </>
  );
}

export interface PresetSwitchRestartRequest {
  toPresetId: string;
  toName: string;
  /** Frozen when asked, so the confirm acts on exactly the panes it named. */
  panes: { id: string; title: string; working: boolean }[];
}

export function buildPresetSwitchRestartRequest(
  notice: PresetSwitchNoticeState,
  paneIds: readonly string[]
): PresetSwitchRestartRequest {
  const panelsById = usePanelStore.getState().panelsById;
  return {
    toPresetId: notice.toPresetId,
    toName: notice.toName,
    panes: paneIds.map((id) => {
      const panel = panelsById[id];
      return {
        id,
        title: panel?.title ?? id,
        working: terminalHasRunningAgentSession(panel),
      };
    }),
  };
}

/** One confirm naming every pane the restart touches, then one restart per pane. */
export function PresetSwitchRestartDialog({
  request,
  onClose,
}: {
  request: PresetSwitchRestartRequest | null;
  onClose: () => void;
}) {
  const handleConfirm = useCallback(() => {
    if (!request) return;
    for (const pane of request.panes) {
      void actionService.dispatch(
        "terminal.restartOnPreset",
        { terminalId: pane.id, presetId: request.toPresetId, confirmed: true },
        { source: "user" }
      );
    }
    closeAndAnnounce(
      onClose,
      `Restarting ${pluralize(request.panes.length, "pane")} on ${request.toName}`
    );
  }, [request, onClose]);

  if (!request) return null;
  const count = request.panes.length;
  const working = request.panes.filter((pane) => pane.working).length;
  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={`Restart ${pluralize(count, "pane")} on '${request.toName}'?`}
      description={
        <>
          {working > 0 && (
            <span className="block font-medium text-text-primary">
              {pluralize(working, "agent is working", "agents are working")} and will be
              interrupted.
            </span>
          )}
          <span className={working > 0 ? "mt-1 block" : undefined}>
            {count === 1
              ? "The agent starts a new conversation on that preset, and the scrollback is discarded."
              : "Each agent starts a new conversation on that preset, and its scrollback is discarded."}
          </span>
        </>
      }
      confirmLabel={count === 1 ? "Restart pane" : `Restart ${pluralize(count, "pane")}`}
      variant="destructive"
      onConfirm={handleConfirm}
    >
      <ul className="mt-2 space-y-0.5 text-sm text-text-primary">
        {request.panes.map((pane) => (
          <li key={pane.id} className="truncate">
            {pane.title}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
