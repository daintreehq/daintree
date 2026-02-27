import { useState, useEffect, useCallback } from "react";
import { RotateCcw, X, Layers, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface TrashGroupItemProps {
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
  worktreeName?: string;
  earliestExpiry: number;
}

export function TrashGroupItem({
  groupRestoreId,
  groupMetadata,
  terminals,
  worktreeName,
  earliestExpiry,
}: TrashGroupItemProps) {
  const restoreTrashedGroup = useTerminalStore((s) => s.restoreTrashedGroup);
  const restoreTerminal = useTerminalStore((s) => s.restoreTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const [isExpanded, setIsExpanded] = useState(false);

  const isOrphan = !!groupMetadata.worktreeId && !worktreeName;
  const canRestore = !isOrphan || !!activeWorktreeId;

  const [timeRemaining, setTimeRemaining] = useState(() => {
    return Math.max(0, earliestExpiry - Date.now());
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, earliestExpiry - Date.now());
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [earliestExpiry]);

  const seconds = Math.ceil(timeRemaining / 1000);

  const handleRestoreGroup = useCallback(() => {
    if (isOrphan && activeWorktreeId) {
      restoreTrashedGroup(groupRestoreId, activeWorktreeId);
    } else {
      restoreTrashedGroup(groupRestoreId);
    }
  }, [restoreTrashedGroup, groupRestoreId, isOrphan, activeWorktreeId]);

  const handleRemoveAll = useCallback(() => {
    for (const { terminal } of terminals) {
      removeTerminal(terminal.id);
    }
  }, [removeTerminal, terminals]);

  const tabCount = terminals.length;
  const groupName = `Tab Group (${tabCount} ${tabCount === 1 ? "tab" : "tabs"})`;

  return (
    <div className="rounded-[var(--radius-sm)] bg-transparent hover:bg-white/5 transition-colors">
      <div className="flex items-center gap-2 px-2.5 py-1.5 group">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 h-4 w-4 p-0 hover:bg-transparent"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label={isExpanded ? "Collapse group" : "Expand group"}
          aria-expanded={isExpanded}
          aria-controls={`trash-group-${groupRestoreId}`}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-canopy-text/60" />
          ) : (
            <ChevronRight className="w-3 h-3 text-canopy-text/60" />
          )}
        </Button>

        <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
          <Layers className="w-3 h-3 text-canopy-text/70" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-canopy-text/70 group-hover:text-canopy-text truncate transition-colors">
            {groupName}
            {worktreeName ? (
              <span className="text-canopy-text/50 ml-1 font-normal">({worktreeName})</span>
            ) : isOrphan ? (
              <span className="text-amber-500/70 ml-1 font-normal text-[11px]">(deleted tree)</span>
            ) : null}
          </div>
          <div className="text-[11px] text-canopy-text/40" aria-live="off">
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
                    onClick={handleRestoreGroup}
                    disabled={!canRestore}
                    aria-label={
                      isOrphan
                        ? canRestore
                          ? `Restore group to current worktree`
                          : "No active worktree to restore to"
                        : `Restore tab group (${tabCount} tabs)`
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isOrphan
                  ? canRestore
                    ? "Restore group to current worktree"
                    : "No active worktree - select a worktree first"
                  : `Restore tab group (${tabCount} tabs)`}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost-danger"
                  size="icon-sm"
                  onClick={handleRemoveAll}
                  aria-label={`Remove all ${tabCount} tabs permanently`}
                >
                  <X aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{`Remove all ${tabCount} tabs permanently`}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {isExpanded && (
        <div
          id={`trash-group-${groupRestoreId}`}
          role="region"
          aria-label="Group panels"
          className="pl-6 pr-2 pb-1.5 space-y-0.5"
        >
          {terminals
            .sort((a, b) => {
              // Sort by original order in groupMetadata if available
              const aIndex = groupMetadata.panelIds.indexOf(a.terminal.id);
              const bIndex = groupMetadata.panelIds.indexOf(b.terminal.id);
              if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
              }
              return 0;
            })
            .map(({ terminal }) => {
              const terminalName = terminal.title || terminal.type || "Terminal";
              const isActiveTab = groupMetadata.activeTabId === terminal.id;
              return (
                <div
                  key={terminal.id}
                  className="flex items-center gap-2 px-2 py-1 text-[11px] rounded hover:bg-white/5 group/panel"
                >
                  <TerminalIcon
                    type={terminal.type}
                    kind={terminal.kind}
                    agentId={terminal.agentId}
                    detectedProcessId={terminal.detectedProcessId}
                    className="w-2.5 h-2.5 opacity-60"
                  />
                  <span
                    className={`truncate flex-1 ${isActiveTab ? "text-canopy-text/70 font-medium" : "text-canopy-text/50"}`}
                  >
                    {terminalName}
                    {isActiveTab && <span className="ml-1 text-canopy-text/40">(active)</span>}
                  </span>
                  <div className="flex gap-0.5 opacity-0 group-hover/panel:opacity-100 transition-opacity">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            <Button
                              variant="ghost-success"
                              size="icon-sm"
                              className="h-4 w-4"
                              onClick={() => {
                                if (isOrphan && activeWorktreeId) {
                                  restoreTerminal(terminal.id, activeWorktreeId);
                                } else {
                                  restoreTerminal(terminal.id);
                                }
                              }}
                              disabled={!canRestore}
                              aria-label={`Restore ${terminalName} only`}
                            >
                              <RotateCcw className="w-2.5 h-2.5" aria-hidden="true" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{`Restore ${terminalName} only`}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost-danger"
                            size="icon-sm"
                            className="h-4 w-4"
                            onClick={() => removeTerminal(terminal.id)}
                            aria-label={`Remove ${terminalName} permanently`}
                          >
                            <X className="w-2.5 h-2.5" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{`Remove ${terminalName} permanently`}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
