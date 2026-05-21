import { useState, useMemo, useCallback } from "react";
import { Moon, Layers, ChevronDown, ChevronRight, RotateCcw, X, Bell, BellOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { usePanelStore, type TerminalInstance } from "@/store";
import type { TrashedTerminalGroupMetadata } from "@/store/slices";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useBackgroundedTerminals } from "@/hooks/useTerminalSelectors";
import { useWorktrees } from "@/hooks/useWorktrees";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { STATE_ICONS, STATE_LABELS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { fireWatchNotification } from "@/lib/watchNotification";
import type { AgentState } from "@/types";

interface BackgroundContainerProps {
  compact?: boolean;
}

interface BackgroundDisplaySingle {
  type: "single";
  terminal: TerminalInstance;
}

interface BackgroundDisplayGroup {
  type: "group";
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: TerminalInstance[];
}

type BackgroundDisplayItem = BackgroundDisplaySingle | BackgroundDisplayGroup;

// PopoverContent has overflow-hidden, which clips the box-shadow used by
// panel-state-waiting / panel-state-working. Use a left-border + tint instead
// so the ambient signal survives at popover row scale.
function rowAmbientClass(agentState: AgentState | undefined): string {
  if (agentState === "waiting") {
    return "border-l-2 border-l-[color:var(--color-activity-waiting)] bg-[color-mix(in_oklab,var(--color-activity-waiting)_8%,transparent)]";
  }
  if (agentState === "working") {
    return "border-l-2 border-l-[color:var(--color-activity-working)] bg-[color-mix(in_oklab,var(--color-activity-working)_6%,transparent)]";
  }
  return "border-l-2 border-l-transparent";
}

export function BackgroundContainer({ compact = false }: BackgroundContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);
  const terminals = useBackgroundedTerminals();
  const backgroundedTerminals = usePanelStore((state) => state.backgroundedTerminals);
  const watchedPanels = usePanelStore((state) => state.watchedPanels);
  const {
    restoreBackgroundTerminal,
    restoreBackgroundGroup,
    activateTerminal,
    pingTerminal,
    removePanel,
    watchPanel,
    unwatchPanel,
  } = usePanelStore(
    useShallow((state) => ({
      restoreBackgroundTerminal: state.restoreBackgroundTerminal,
      restoreBackgroundGroup: state.restoreBackgroundGroup,
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
      removePanel: state.removePanel,
      watchPanel: state.watchPanel,
      unwatchPanel: state.unwatchPanel,
    }))
  );
  const { activeWorktreeId, selectWorktree, trackTerminalFocus } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      selectWorktree: state.selectWorktree,
      trackTerminalFocus: state.trackTerminalFocus,
    }))
  );
  const { worktreeMap } = useWorktrees();

  const waitingCount = useMemo(
    () => terminals.filter((t) => t.agentState === "waiting").length,
    [terminals]
  );

  const displayItems = useMemo((): BackgroundDisplayItem[] => {
    const groups = new Map<
      string,
      {
        metadata: TrashedTerminalGroupMetadata | undefined;
        terminals: TerminalInstance[];
      }
    >();
    const singles: TerminalInstance[] = [];

    for (const terminal of terminals) {
      const bgInfo = backgroundedTerminals.get(terminal.id);
      if (bgInfo?.groupRestoreId) {
        const existing = groups.get(bgInfo.groupRestoreId);
        if (existing) {
          existing.terminals.push(terminal);
          if (bgInfo.groupMetadata) {
            existing.metadata = bgInfo.groupMetadata;
          }
        } else {
          groups.set(bgInfo.groupRestoreId, {
            metadata: bgInfo.groupMetadata,
            terminals: [terminal],
          });
        }
      } else {
        singles.push(terminal);
      }
    }

    const items: BackgroundDisplayItem[] = [];

    for (const [groupRestoreId, group] of groups) {
      if (group.metadata && group.terminals.length > 1) {
        items.push({
          type: "group",
          groupRestoreId,
          groupMetadata: group.metadata,
          terminals: group.terminals,
        });
      } else {
        for (const terminal of group.terminals) {
          items.push({ type: "single", terminal });
        }
      }
    }

    for (const terminal of singles) {
      items.push({ type: "single", terminal });
    }

    return items;
  }, [terminals, backgroundedTerminals]);

  const handleRestoreSingle = useCallback(
    (terminal: TerminalInstance) => {
      const worktreeId = terminal.worktreeId?.trim();
      if (worktreeId && worktreeId !== activeWorktreeId) {
        trackTerminalFocus(worktreeId, terminal.id);
        selectWorktree(worktreeId);
      }
      restoreBackgroundTerminal(terminal.id);
      activateTerminal(terminal.id);
      pingTerminal(terminal.id);
      setIsOpen(false);
    },
    [
      activeWorktreeId,
      trackTerminalFocus,
      selectWorktree,
      restoreBackgroundTerminal,
      activateTerminal,
      pingTerminal,
    ]
  );

  const handleRestoreGroup = useCallback(
    (groupRestoreId: string, groupMetadata: TrashedTerminalGroupMetadata) => {
      const worktreeId = groupMetadata.worktreeId?.trim();
      if (worktreeId && worktreeId !== activeWorktreeId) {
        selectWorktree(worktreeId);
      }
      restoreBackgroundGroup(groupRestoreId);
      const activeId = groupMetadata.activeTabId;
      if (activeId) {
        if (worktreeId) {
          trackTerminalFocus(worktreeId, activeId);
        }
        activateTerminal(activeId);
        pingTerminal(activeId);
      }
      setIsOpen(false);
    },
    [
      activeWorktreeId,
      trackTerminalFocus,
      selectWorktree,
      restoreBackgroundGroup,
      activateTerminal,
      pingTerminal,
    ]
  );

  const handleWatchToggle = useCallback(
    (terminal: TerminalInstance) => {
      const id = terminal.id;
      if (watchedPanels.has(id)) {
        unwatchPanel(id);
        return;
      }
      if (
        terminal.agentState === "completed" ||
        terminal.agentState === "waiting" ||
        terminal.agentState === "exited"
      ) {
        fireWatchNotification(id, terminal.title ?? id, terminal.agentState);
        return;
      }
      watchPanel(id);
    },
    [watchedPanels, watchPanel, unwatchPanel]
  );

  const killTarget = useMemo(
    () => (killConfirmId ? terminals.find((t) => t.id === killConfirmId) : undefined),
    [killConfirmId, terminals]
  );

  const handleKillConfirm = useCallback(() => {
    if (killConfirmId) {
      removePanel(killConfirmId);
    }
    setKillConfirmId(null);
  }, [killConfirmId, removePanel]);

  if (terminals.length === 0) return null;

  const count = terminals.length;
  const triggerLabel =
    waitingCount > 0 ? `Background (${count} · ${waitingCount} waiting)` : `Background (${count})`;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="pill"
          size="sm"
          className={cn(
            compact ? "px-1.5 min-w-0" : "px-3",
            isOpen && "bg-overlay-emphasis border-border-default"
          )}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls="background-container-popover"
          aria-label={triggerLabel}
        >
          <span className="relative">
            <Moon className="w-3.5 h-3.5 text-daintree-text/50" aria-hidden="true" />
            {compact && count > 0 && (
              <span
                className={cn(
                  "absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full text-[10px] font-bold tabular-nums shadow-sm",
                  waitingCount > 0
                    ? "bg-state-waiting text-daintree-bg"
                    : "bg-daintree-text/20 text-daintree-text"
                )}
              >
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
          {!compact && (
            <span className="font-medium tabular-nums">
              Background ({count}
              {waitingCount > 0 && (
                <>
                  {" · "}
                  <span className="text-state-waiting">{waitingCount} waiting</span>
                </>
              )}
              )
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id="background-container-popover"
        role="dialog"
        aria-label="Backgrounded panels"
        className="w-96 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          // Keep the popover anchored while the kill confirm dialog is open;
          // AppDialog is a react-dom portal with no Radix marker on its root,
          // so we gate on local state rather than a DOM selector.
          if (killConfirmId !== null) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (killConfirmId !== null) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (killConfirmId !== null) e.preventDefault();
        }}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-daintree-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-daintree-text/70">Background panels</span>
            {waitingCount > 0 && (
              <span className="text-[10px] font-medium text-state-waiting tabular-nums">
                {waitingCount} waiting
              </span>
            )}
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[360px] overflow-y-auto">
            {displayItems.map((item) => {
              if (item.type === "group") {
                return (
                  <BackgroundGroupItem
                    key={item.groupRestoreId}
                    groupRestoreId={item.groupRestoreId}
                    groupMetadata={item.groupMetadata}
                    terminals={item.terminals}
                    worktreeMap={worktreeMap}
                    watchedPanels={watchedPanels}
                    onRestoreGroup={handleRestoreGroup}
                    onRestoreSingle={handleRestoreSingle}
                    onWatchToggle={handleWatchToggle}
                    onKill={(id) => setKillConfirmId(id)}
                  />
                );
              }
              const worktreeName = item.terminal.worktreeId
                ? worktreeMap.get(item.terminal.worktreeId)?.name
                : undefined;
              return (
                <BackgroundSingleItem
                  key={item.terminal.id}
                  terminal={item.terminal}
                  worktreeName={worktreeName}
                  isWatched={watchedPanels.has(item.terminal.id)}
                  onRestore={handleRestoreSingle}
                  onWatchToggle={handleWatchToggle}
                  onKill={(id) => setKillConfirmId(id)}
                />
              );
            })}
          </div>
        </div>
      </PopoverContent>

      <ConfirmDialog
        isOpen={killConfirmId !== null}
        onClose={() => setKillConfirmId(null)}
        title="Kill terminal?"
        description={
          killTarget
            ? `${killTarget.title || "The terminal"} will be terminated and cannot be recovered.`
            : "The terminal will be terminated and cannot be recovered."
        }
        variant="destructive"
        confirmLabel="Kill terminal"
        onConfirm={handleKillConfirm}
      />
    </Popover>
  );
}

interface BackgroundSingleItemProps {
  terminal: TerminalInstance;
  worktreeName: string | undefined;
  isWatched: boolean;
  onRestore: (terminal: TerminalInstance) => void;
  onWatchToggle: (terminal: TerminalInstance) => void;
  onKill: (terminalId: string) => void;
  compact?: boolean;
}

function BackgroundSingleItem({
  terminal,
  worktreeName,
  isWatched,
  onRestore,
  onWatchToggle,
  onKill,
  compact = false,
}: BackgroundSingleItemProps) {
  const agentState = terminal.agentState;
  const StateIcon = agentState ? STATE_ICONS[agentState] : null;
  const stateLabel = agentState ? STATE_LABELS[agentState] : null;
  const stateColor = agentState ? STATE_COLORS[agentState] : null;
  const title = terminal.title || "Terminal";

  return (
    <div
      data-testid="background-single-item"
      data-agent-state={agentState ?? "unknown"}
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-tint/5 transition-colors group",
        rowAmbientClass(agentState),
        compact && "py-1 pl-1.5"
      )}
    >
      <div className="shrink-0 mt-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
        <TerminalIcon
          kind={terminal.kind}
          chrome={deriveTerminalChrome(terminal)}
          className={compact ? "h-2.5 w-2.5" : "h-3 w-3"}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "truncate font-medium text-daintree-text/80 group-hover:text-daintree-text transition-colors",
              compact ? "text-[11px]" : "text-xs"
            )}
          >
            {title}
          </span>
          {terminal.lastStateChange != null && (
            <LiveTimeAgo
              timestamp={terminal.lastStateChange}
              className="text-[10px] text-daintree-text/40 shrink-0"
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-daintree-text/55">
          {worktreeName && <span className="truncate">{worktreeName}</span>}
          {worktreeName && (stateLabel || terminal.activityHeadline) && (
            <span className="text-daintree-text/30">·</span>
          )}
          {StateIcon && stateLabel && (
            <span className={cn("inline-flex items-center gap-1 shrink-0", stateColor)}>
              <StateIcon className="h-2.5 w-2.5" />
              <span>{stateLabel}</span>
            </span>
          )}
          {terminal.activityHeadline && (
            <>
              {(worktreeName || stateLabel) && <span className="text-daintree-text/30">·</span>}
              <span className="truncate italic text-daintree-text/50">
                {terminal.activityHeadline}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-0.5 shrink-0 mt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onWatchToggle(terminal);
              }}
              aria-label={isWatched ? "Stop watching" : "Watch for completion"}
              aria-pressed={isWatched}
              data-testid="bg-watch-button"
              className={cn(isWatched && "text-status-info")}
            >
              {isWatched ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isWatched ? "Stop watching" : "Watch for completion"}
          </TooltipContent>
        </Tooltip>

        {!compact && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost-success"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore(terminal);
                }}
                aria-label={`Restore ${title}`}
                data-testid="bg-restore-button"
              >
                <RotateCcw aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{`Restore ${title}`}</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost-danger"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onKill(terminal.id);
              }}
              aria-label={`Kill ${title}`}
              data-testid="bg-kill-button"
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{`Kill ${title}`}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function BackgroundGroupItem({
  groupRestoreId,
  groupMetadata,
  terminals,
  worktreeMap,
  watchedPanels,
  onRestoreGroup,
  onRestoreSingle,
  onWatchToggle,
  onKill,
}: {
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: TerminalInstance[];
  worktreeMap: ReturnType<typeof useWorktrees>["worktreeMap"];
  watchedPanels: Set<string>;
  onRestoreGroup: (groupRestoreId: string, metadata: TrashedTerminalGroupMetadata) => void;
  onRestoreSingle: (terminal: TerminalInstance) => void;
  onWatchToggle: (terminal: TerminalInstance) => void;
  onKill: (terminalId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const tabCount = terminals.length;
  const groupName = `Tab group (${tabCount} ${tabCount === 1 ? "tab" : "tabs"})`;
  const groupWaiting = terminals.filter((t) => t.agentState === "waiting").length;

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
          aria-controls={`bg-group-${groupRestoreId}`}
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
            {groupWaiting > 0 && (
              <span className="ml-1.5 text-[10px] text-state-waiting font-normal tabular-nums">
                · {groupWaiting} waiting
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          className="text-[10px] text-daintree-text/40 shrink-0 hover:text-daintree-text transition-colors"
          onClick={() => onRestoreGroup(groupRestoreId, groupMetadata)}
        >
          Restore all
        </button>
      </div>

      {isExpanded && (
        <div
          id={`bg-group-${groupRestoreId}`}
          role="region"
          aria-label="Group panels"
          className="pl-5 pr-1 pb-1.5 space-y-0.5"
        >
          {[...terminals]
            .sort((a, b) => {
              const aIndex = groupMetadata.panelIds.indexOf(a.id);
              const bIndex = groupMetadata.panelIds.indexOf(b.id);
              if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
              return 0;
            })
            .map((terminal) => {
              const worktreeName = terminal.worktreeId
                ? worktreeMap.get(terminal.worktreeId)?.name
                : undefined;
              return (
                <BackgroundSingleItem
                  key={terminal.id}
                  terminal={terminal}
                  worktreeName={worktreeName}
                  isWatched={watchedPanels.has(terminal.id)}
                  onRestore={onRestoreSingle}
                  onWatchToggle={onWatchToggle}
                  onKill={onKill}
                  compact
                />
              );
            })}
        </div>
      )}
    </div>
  );
}
