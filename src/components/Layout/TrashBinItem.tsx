import { useCallback, useState, useSyncExternalStore } from "react";
import { RotateCcw, X } from "lucide-react";
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
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { cn } from "@/lib/utils";

// Reveal precise seconds only when the deadline is imminent (≤5s, the M3/WCAG
// "final approach" window). Outside that, the row stays quiet and the value is
// available on hover or keyboard focus. Sub-threshold meta-info should not tick.
const COUNTDOWN_CRITICAL_SECONDS = 5;

interface TrashBinItemProps {
  terminal: PanelInstance;
  trashedInfo: TrashedTerminal;
  worktreeName?: string;
}

export function TrashBinItem({ terminal, trashedInfo, worktreeName }: TrashBinItemProps) {
  const restoreTerminal = usePanelStore((s) => s.restoreTerminal);
  const removePanel = usePanelStore((s) => s.removePanel);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  // Re-render when a plugin loads/unloads mid-session so the trashed terminal's
  // icon/name pick up the updated registry (#9879). Subscription is the
  // mechanism; the value itself is read via getEffectiveAgentConfig below.
  useSyncExternalStore(subscribeToPluginAgentRegistry, getPluginAgentRegistrySnapshot);

  const isOrphan = !!terminal.worktreeId && !worktreeName;

  const [now, setNow] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);
  const timeRemaining = Math.max(0, trashedInfo.expiresAt - now);
  const seconds = Math.ceil(timeRemaining / 1000);

  const canRestore = !isOrphan || !!activeWorktreeId;

  const handleRestore = useCallback(() => {
    if (isOrphan && activeWorktreeId) {
      restoreTerminal(terminal.id, activeWorktreeId);
    } else {
      restoreTerminal(terminal.id);
    }
  }, [restoreTerminal, terminal.id, isOrphan, activeWorktreeId]);

  const handleKill = useCallback(() => {
    removePanel(terminal.id);
  }, [removePanel, terminal.id]);

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

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-transparent hover:bg-tint/5 transition-colors group">
      <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <TerminalIcon
          kind={terminal.kind}
          chrome={deriveTerminalChrome(terminal)}
          className="w-3 h-3"
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-daintree-text/70 group-hover:text-daintree-text truncate transition-colors">
          {terminalName}
          {worktreeName ? (
            <span className="text-daintree-text/50 ml-1 font-normal">({worktreeName})</span>
          ) : isOrphan ? (
            <span className="text-status-warning/70 ml-1 font-normal text-[11px]">
              (deleted tree)
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "text-[11px] tabular-nums transition-opacity",
            seconds <= COUNTDOWN_CRITICAL_SECONDS
              ? "opacity-100 text-status-warning/70"
              : "text-text-secondary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          )}
          aria-hidden="true"
        >
          {seconds}s remaining
        </div>
      </div>

      <div className="flex gap-1">
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
    </div>
  );
}
