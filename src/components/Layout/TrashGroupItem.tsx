import { useState, useCallback, useSyncExternalStore } from "react";
import { RotateCcw, X, Layers, ChevronDown, ChevronRight, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
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

interface TrashGroupItemProps {
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: Array<{
    terminal: PanelInstance;
    trashedInfo: TrashedTerminal;
  }>;
  worktreeName?: string;
  earliestExpiry: number;
  /** Raise a permanent removal for the container to confirm. */
  onRequestRemove: (request: TrashRemovalRequest) => void;
}

export function TrashGroupItem({
  groupRestoreId,
  groupMetadata,
  terminals,
  worktreeName,
  earliestExpiry,
  onRequestRemove,
}: TrashGroupItemProps) {
  const restoreTrashedGroup = usePanelStore((s) => s.restoreTrashedGroup);
  const restoreTerminal = usePanelStore((s) => s.restoreTerminal);
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  // Re-render when a plugin loads/unloads mid-session so trashed terminals'
  // icon/name pick up the updated registry (#9879). Subscription is the
  // mechanism; the value itself is read via getEffectiveAgentConfig below.
  useSyncExternalStore(subscribeToPluginAgentRegistry, getPluginAgentRegistrySnapshot);

  const [isExpanded, setIsExpanded] = useState(false);

  const isOrphan = !!groupMetadata.worktreeId && !worktreeName;
  const canRestore = !isOrphan || !!activeWorktreeId;

  const countdown = useTrashCountdown(earliestExpiry);

  const handleRestoreGroup = useCallback(() => {
    if (isOrphan && activeWorktreeId) {
      restoreTrashedGroup(groupRestoreId, activeWorktreeId);
    } else {
      restoreTrashedGroup(groupRestoreId);
    }
  }, [restoreTrashedGroup, groupRestoreId, isOrphan, activeWorktreeId]);

  const tabCount = terminals.length;

  // Only resolve the headline title when the active id still points at a real
  // terminal in the group — if individual deletes have left the id stale, the
  // (active) marker won't render either, so falling back to the count-only
  // label keeps the header and expanded list consistent.
  const activeEntry = terminals.find(({ terminal }) => terminal.id === groupMetadata.activeTabId);

  const resolvedActiveTitle = (() => {
    if (!activeEntry) return null;
    const { terminal } = activeEntry;
    if (isPtyPanel(terminal)) {
      // A user-locked title is fully frozen — it outranks the observed task.
      if ((terminal.titleMode ?? "default") === "user") return terminal.title;
      const observed = cleanTaskTitle(terminal.lastObservedTitle);
      if (observed && !isUselessTitle(observed)) return observed;
      if (terminal.launchAgentId) {
        if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
        const agentConfig = getEffectiveAgentConfig(terminal.launchAgentId);
        return agentConfig?.name ?? terminal.launchAgentId;
      }
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

  const childName = useCallback((terminal: PanelInstance) => terminal.title || "Terminal", []);

  const handleRemoveAll = useCallback(() => {
    // Every member by name, not just the count: a bundled destruction owes the
    // user a preview of what it is actually destroying.
    onRequestRemove({
      ids: terminals.map(({ terminal }) => terminal.id),
      label: groupName,
      panelTitles: terminals.map(({ terminal }) => childName(terminal)),
    });
  }, [onRequestRemove, terminals, groupName, childName]);

  return (
    <div
      data-trash-row
      data-row-id={groupRestoreId}
      className="relative shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-transparent transition-colors hover:bg-tint/5"
    >
      <div className="flex items-start gap-2 px-2.5 py-1.5 group">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 mt-0.5 h-4 w-4 p-0 hover:bg-transparent"
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

        <div className="shrink-0 mt-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
          <Layers className="w-3 h-3 text-daintree-text/70" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-text-secondary group-hover:text-text-primary truncate transition-colors">
            {groupName}
          </div>
          {/* Same metadata line as a single row, so the deadline sits at the
              same x in both and the two kinds of row can be ranked together. */}
          <div className="flex items-center gap-1.5 mt-0.5 text-2xs">
            <TrashCountdownLabel countdown={countdown} name={groupName} />
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
                  className="flex items-center gap-2 px-2 py-1 text-2xs rounded-[var(--radius-sm)] hover:bg-tint/5 group/panel"
                >
                  <TerminalIcon
                    kind={terminal.kind}
                    chrome={deriveTerminalChrome(terminal)}
                    className="w-2.5 h-2.5 text-text-muted"
                  />
                  <span
                    className={`truncate flex-1 ${isActiveTab ? "text-text-primary font-medium" : "text-text-secondary"}`}
                  >
                    {terminalName}
                    {isActiveTab && (
                      <span className="ml-1 font-normal text-text-secondary">(active)</span>
                    )}
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity group-hover/panel:opacity-100 group-focus-within/panel:opacity-100">
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
                          onClick={() =>
                            onRequestRemove({
                              ids: [terminal.id],
                              label: terminalName,
                              panelTitles: [],
                            })
                          }
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

      <TrashTtlMeter countdown={countdown} />
    </div>
  );
}
