import { useCallback, useSyncExternalStore } from "react";
import { RotateCcw, Unlink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { TrashedTerminal } from "@/store/slices";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { cleanTaskTitle } from "@shared/utils/taskTitle";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import {
  TrashCountdownLabel,
  TrashTtlMeter,
  useTrashCountdown,
  type TrashRemovalRequest,
} from "./trashCountdown";

interface TrashBinItemProps {
  terminal: PanelInstance;
  trashedInfo: TrashedTerminal;
  worktreeName?: string;
  /** Raise a permanent removal for the container to confirm. */
  onRequestRemove: (request: TrashRemovalRequest) => void;
}

export function TrashBinItem({
  terminal,
  trashedInfo,
  worktreeName,
  onRequestRemove,
}: TrashBinItemProps) {
  const restoreTerminal = usePanelStore((s) => s.restoreTerminal);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  // Re-render when a plugin loads/unloads mid-session so the trashed terminal's
  // icon/name pick up the updated registry (#9879). Subscription is the
  // mechanism; the value itself is read via getEffectiveAgentConfig below.
  useSyncExternalStore(subscribeToPluginAgentRegistry, getPluginAgentRegistrySnapshot);

  const isOrphan = !!terminal.worktreeId && !worktreeName;

  const countdown = useTrashCountdown(trashedInfo.expiresAt);

  const canRestore = !isOrphan || !!activeWorktreeId;

  const handleRestore = useCallback(() => {
    if (isOrphan && activeWorktreeId) {
      restoreTerminal(terminal.id, activeWorktreeId);
    } else {
      restoreTerminal(terminal.id);
    }
  }, [restoreTerminal, terminal.id, isOrphan, activeWorktreeId]);

  const terminalName = (() => {
    if (isPtyPanel(terminal)) {
      // A user-locked title is fully frozen — it outranks the observed task.
      if ((terminal.titleMode ?? "default") === "user") return terminal.title;
      const observed = cleanTaskTitle(terminal.lastObservedTitle);
      if (observed && !isUselessTitle(observed)) return observed;
      // Launch-intent only: trash labels should read the stable launch identity
      // so a terminal's name doesn't change as runtime detection flips after trashing.
      if (terminal.launchAgentId) {
        if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
        const agentConfig = getEffectiveAgentConfig(terminal.launchAgentId);
        return agentConfig?.name ?? terminal.launchAgentId;
      }
    }
    return terminal.title || "Terminal";
  })();

  const handleKill = useCallback(() => {
    onRequestRemove({ ids: [terminal.id], label: terminalName, panelTitles: [] });
  }, [onRequestRemove, terminal.id, terminalName]);

  return (
    <div
      data-trash-row
      data-row-id={terminal.id}
      className="relative flex shrink-0 items-start gap-2 overflow-hidden rounded-[var(--radius-sm)] bg-transparent px-2.5 py-1.5 transition-colors hover:bg-tint/5 group"
    >
      <div className="shrink-0 mt-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
        <TerminalIcon
          kind={terminal.kind}
          chrome={deriveTerminalChrome(terminal)}
          className="w-3 h-3"
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text-secondary group-hover:text-text-primary truncate transition-colors">
          {terminalName}
        </div>
        {/* The deadline leads the metadata line, at the same x on every row, so
            a list of them can be ranked without reading any of the numbers.
            The identity that follows it is what truncates under width pressure;
            the deadline never does. */}
        <div className="flex items-center gap-1.5 mt-0.5 text-2xs">
          <TrashCountdownLabel countdown={countdown} name={terminalName} />
          {worktreeName ? (
            <>
              <span aria-hidden="true" className="text-text-muted">
                &middot;
              </span>
              <span className="truncate text-text-secondary">{worktreeName}</span>
            </>
          ) : isOrphan ? (
            <>
              <span aria-hidden="true" className="text-text-muted">
                &middot;
              </span>
              {/* A glyph, not just a colour: at the final approach the deadline
                  beside it is warning-coloured too, and two warnings that differ
                  only in hue read as one. */}
              <span className="inline-flex shrink-0 items-center gap-1 text-status-warning">
                <Unlink className="h-2.5 w-2.5" aria-hidden="true" />
                Worktree deleted
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost-success"
                size="icon-sm"
                onClick={handleRestore}
                disabled={!canRestore}
                aria-label={
                  isOrphan
                    ? canRestore
                      ? `Adopt ${terminalName} to current worktree`
                      : "No active worktree to restore to"
                    : `Restore ${terminalName}`
                }
              >
                <RotateCcw aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isOrphan
              ? canRestore
                ? "Adopt to current worktree"
                : "No active worktree - select a worktree first"
              : `Restore ${terminalName}`}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost-danger"
              size="icon-sm"
              onClick={handleKill}
              aria-label={`Remove ${terminalName} permanently`}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{`Remove ${terminalName} permanently`}</TooltipContent>
        </Tooltip>
      </div>

      <TrashTtlMeter countdown={countdown} />
    </div>
  );
}
