import { useState, useEffect, useCallback } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelStore, type TerminalInstance } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { TrashedTerminal } from "@/store/slices";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

interface TrashBinItemProps {
  terminal: TerminalInstance;
  trashedInfo: TrashedTerminal;
  worktreeName?: string;
}

export function TrashBinItem({ terminal, trashedInfo, worktreeName }: TrashBinItemProps) {
  const restoreTerminal = usePanelStore((s) => s.restoreTerminal);
  const removePanel = usePanelStore((s) => s.removePanel);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const isOrphan = !!terminal.worktreeId && !worktreeName;

  const [timeRemaining, setTimeRemaining] = useState(() => {
    return Math.max(0, trashedInfo.expiresAt - Date.now());
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, trashedInfo.expiresAt - Date.now());
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [trashedInfo.expiresAt]);

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
    const observed = terminal.lastObservedTitle;
    if (observed && !isUselessTitle(observed)) return observed;
    // Launch-intent only: trash labels should read the stable launch identity
    // so a terminal's name doesn't change as runtime detection flips after trashing.
    if (terminal.agentId) {
      if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
      const agentConfig = getEffectiveAgentConfig(terminal.agentId);
      return agentConfig?.name ?? terminal.agentId;
    }
    return terminal.title || "Terminal";
  })();

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-transparent hover:bg-tint/5 transition-colors group">
      <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <TerminalIcon
          kind={terminal.kind}
          agentId={terminal.agentId}
          detectedAgentId={terminal.detectedAgentId}
          detectedProcessId={terminal.detectedProcessId}
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
        <div className="text-[11px] text-daintree-text/40" aria-live="polite">
          {seconds}s remaining
        </div>
      </div>

      <div className="flex gap-1">
        <TooltipProvider>
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
        </TooltipProvider>
        <TooltipProvider>
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
        </TooltipProvider>
      </div>
    </div>
  );
}
