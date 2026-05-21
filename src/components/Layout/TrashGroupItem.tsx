import { useState, useCallback } from "react";
import { RotateCcw, X, Layers, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelStore, type TerminalInstance } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { cn } from "@/lib/utils";

const COUNTDOWN_CRITICAL_SECONDS = 5;

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
  const restoreTrashedGroup = usePanelStore((s) => s.restoreTrashedGroup);
  const restoreTerminal = usePanelStore((s) => s.restoreTerminal);
  const removePanel = usePanelStore((s) => s.removePanel);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const [isExpanded, setIsExpanded] = useState(false);

  const isOrphan = !!groupMetadata.worktreeId && !worktreeName;
  const canRestore = !isOrphan || !!activeWorktreeId;

  const [now, setNow] = useState(() => Date.now());
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);
  const timeRemaining = Math.max(0, earliestExpiry - now);
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
      removePanel(terminal.id);
    }
  }, [removePanel, terminals]);

  const tabCount = terminals.length;

  // Only resolve the headline title when the active id still points at a real
  // terminal in the group — if individual deletes have left the id stale, the
  // (active) marker won't render either, so falling back to the count-only
  // label keeps the header and expanded list consistent.
  const activeEntry = terminals.find(({ terminal }) => terminal.id === groupMetadata.activeTabId);

  const resolvedActiveTitle = (() => {
    if (!activeEntry) return null;
    const { terminal } = activeEntry;
    const observed = terminal.lastObservedTitle;
    if (observed && !isUselessTitle(observed)) return observed;
    if (terminal.launchAgentId) {
      if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
      const agentConfig = getEffectiveAgentConfig(terminal.launchAgentId);
      return agentConfig?.name ?? terminal.launchAgentId;
    }
    if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
    return null;
  })();

  const fallbackName = `Tab group (${tabCount} ${tabCount === 1 ? "tab" : "tabs"})`;
  const groupName = resolvedActiveTitle
    ? tabCount > 1
      ? `${resolvedActiveTitle} +${tabCount - 1} more`
      : resolvedActiveTitle
    : fallbackName;

  return (
    <div className="rounded-[var(--radius-sm)] bg-transparent hover:bg-tint/5 transition-colors">
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
            <ChevronDown className="w-3 h-3 text-daintree-text/60" />
          ) : (
            <ChevronRight className="w-3 h-3 text-daintree-text/60" />
          )}
        </Button>

        <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
          <Layers className="w-3 h-3 text-daintree-text/70" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-daintree-text/70 group-hover:text-daintree-text truncate transition-colors">
            {groupName}
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
                : "text-daintree-text/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
              const terminalName = terminal.title || "Terminal";
              const isActiveTab = groupMetadata.activeTabId === terminal.id;
              return (
                <div
                  key={terminal.id}
                  className="flex items-center gap-2 px-2 py-1 text-[11px] rounded hover:bg-tint/5 group/panel"
                >
                  <TerminalIcon
                    kind={terminal.kind}
                    chrome={deriveTerminalChrome(terminal)}
                    className="w-2.5 h-2.5 opacity-60"
                  />
                  <span
                    className={`truncate flex-1 ${isActiveTab ? "text-daintree-text/70 font-medium" : "text-daintree-text/50"}`}
                  >
                    {terminalName}
                    {isActiveTab && <span className="ml-1 text-daintree-text/40">(active)</span>}
                  </span>
                  <div className="flex gap-0.5 opacity-0 group-hover/panel:opacity-100 transition-opacity">
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost-danger"
                          size="icon-sm"
                          className="h-4 w-4"
                          onClick={() => removePanel(terminal.id)}
                          aria-label={`Remove ${terminalName} permanently`}
                        >
                          <X className="w-2.5 h-2.5" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{`Remove ${terminalName} permanently`}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
