import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, Layers, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { usePanelStore, type TerminalInstance } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import { useWorktrees } from "@/hooks/useWorktrees";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { STATE_ICONS, STATE_LABELS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { TabGroup } from "@/types";

interface WaitingContainerProps {
  compact?: boolean;
}

interface WaitingDisplaySingle {
  type: "single";
  terminal: TerminalInstance;
  groupId: string | null;
}

interface WaitingDisplayGroup {
  type: "group";
  group: TabGroup;
  waitingTerminals: TerminalInstance[];
}

type WaitingDisplayItem = WaitingDisplaySingle | WaitingDisplayGroup;

export function WaitingContainer({ compact = false }: WaitingContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);
  const terminals = useWaitingTerminals();
  const tabGroups = usePanelStore((state) => state.tabGroups);
  const { activateTerminal, pingTerminal, removePanel, setActiveTab } = usePanelStore(
    useShallow((state) => ({
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
      removePanel: state.removePanel,
      setActiveTab: state.setActiveTab,
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

  const displayItems = useMemo((): WaitingDisplayItem[] => {
    // Build panelId -> group, applying the same location guard as
    // getPanelGroup so a stale group whose location no longer matches the
    // panel falls through to a single row instead of mis-routing setActiveTab.
    const panelToGroup = new Map<string, TabGroup>();
    const waitingByPanelId = new Map<string, TerminalInstance>();
    for (const terminal of terminals) waitingByPanelId.set(terminal.id, terminal);
    for (const group of tabGroups.values()) {
      for (const panelId of group.panelIds) {
        const panel = waitingByPanelId.get(panelId);
        if (!panel) continue;
        const panelLocation = panel.location === "dock" ? "dock" : "grid";
        if (panelLocation !== group.location) continue;
        panelToGroup.set(panelId, group);
      }
    }

    const groupBuckets = new Map<string, { group: TabGroup; waitingMembers: TerminalInstance[] }>();
    const singles: WaitingDisplaySingle[] = [];

    for (const terminal of terminals) {
      const group = panelToGroup.get(terminal.id);
      if (group) {
        const bucket = groupBuckets.get(group.id);
        if (bucket) {
          bucket.waitingMembers.push(terminal);
        } else {
          groupBuckets.set(group.id, { group, waitingMembers: [terminal] });
        }
      } else {
        singles.push({ type: "single", terminal, groupId: null });
      }
    }

    const items: WaitingDisplayItem[] = [];

    for (const { group, waitingMembers } of groupBuckets.values()) {
      if (waitingMembers.length > 1) {
        items.push({ type: "group", group, waitingTerminals: waitingMembers });
      } else {
        for (const terminal of waitingMembers) {
          items.push({ type: "single", terminal, groupId: group.id });
        }
      }
    }

    for (const single of singles) {
      items.push(single);
    }

    return items;
  }, [terminals, tabGroups]);

  const handleActivate = useCallback(
    (terminal: TerminalInstance, groupId: string | null) => {
      const worktreeId = terminal.worktreeId?.trim();
      if (worktreeId && worktreeId !== activeWorktreeId) {
        trackTerminalFocus(worktreeId, terminal.id);
        selectWorktree(worktreeId);
      }
      if (groupId) {
        setActiveTab(groupId, terminal.id);
      }
      activateTerminal(terminal.id);
      pingTerminal(terminal.id);
      setIsOpen(false);
    },
    [
      activeWorktreeId,
      trackTerminalFocus,
      selectWorktree,
      setActiveTab,
      activateTerminal,
      pingTerminal,
    ]
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
  const WaitingIcon = STATE_ICONS.waiting;

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
          aria-controls="waiting-container-popover"
          aria-label={`Waiting (${count})`}
        >
          <span className="relative">
            <WaitingIcon className="w-3.5 h-3.5 text-state-waiting" aria-hidden="true" />
            {compact && count > 0 && (
              <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full text-[10px] font-bold tabular-nums shadow-sm bg-state-waiting text-daintree-bg">
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
          {!compact && (
            <span className="font-medium tabular-nums">
              Waiting (<span className="text-state-waiting">{count}</span>)
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id="waiting-container-popover"
        role="dialog"
        aria-label="Waiting panels"
        className="w-96 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
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
            <span className="text-xs font-medium text-daintree-text/70">Waiting for input</span>
            <span className="text-[10px] font-medium text-state-waiting tabular-nums">
              {count} {count === 1 ? "agent" : "agents"}
            </span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[360px] overflow-y-auto">
            {displayItems.map((item) => {
              if (item.type === "group") {
                return (
                  <WaitingGroupItem
                    key={item.group.id}
                    group={item.group}
                    waitingTerminals={item.waitingTerminals}
                    worktreeMap={worktreeMap}
                    onActivate={handleActivate}
                    onKill={(id) => setKillConfirmId(id)}
                  />
                );
              }
              const worktreeName = item.terminal.worktreeId
                ? worktreeMap.get(item.terminal.worktreeId)?.name
                : undefined;
              return (
                <WaitingSingleItem
                  key={item.terminal.id}
                  terminal={item.terminal}
                  groupId={item.groupId}
                  worktreeName={worktreeName}
                  onActivate={handleActivate}
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

interface WaitingSingleItemProps {
  terminal: TerminalInstance;
  groupId: string | null;
  worktreeName: string | undefined;
  onActivate: (terminal: TerminalInstance, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
  compact?: boolean;
}

function WaitingSingleItem({
  terminal,
  groupId,
  worktreeName,
  onActivate,
  onKill,
  compact = false,
}: WaitingSingleItemProps) {
  const agentState = terminal.agentState;
  const StateIcon = agentState ? STATE_ICONS[agentState] : null;
  const stateLabel = agentState ? STATE_LABELS[agentState] : null;
  const stateColor = agentState ? STATE_COLORS[agentState] : null;
  const title = terminal.title || "Terminal";

  return (
    // The row is a div + role="button" rather than a native <button>
    // because the kill icon-button is a sibling target inside this row;
    // nesting <button> inside <button> is invalid HTML and breaks
    // keyboard / screen-reader semantics.
    <div
      data-testid="waiting-single-item"
      data-agent-state={agentState ?? "unknown"}
      role="button"
      tabIndex={0}
      onClick={() => onActivate(terminal, groupId)}
      onKeyDown={(e) => {
        // Ignore Enter / Space bubbled from the inner kill button.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(terminal, groupId);
        }
      }}
      className={cn(
        "flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border-l-2 border-l-transparent hover:bg-tint/5 focus:bg-tint/5 focus-visible:outline-2 focus-visible:outline-daintree-accent outline-hidden transition-colors group cursor-pointer w-full",
        compact && "py-1 pl-1.5"
      )}
      aria-label={`Focus ${title}`}
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
              variant="ghost-danger"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onKill(terminal.id);
              }}
              aria-label={`Kill ${title}`}
              data-testid="waiting-kill-button"
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

interface WaitingGroupItemProps {
  group: TabGroup;
  waitingTerminals: TerminalInstance[];
  worktreeMap: ReturnType<typeof useWorktrees>["worktreeMap"];
  onActivate: (terminal: TerminalInstance, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
}

function WaitingGroupItem({
  group,
  waitingTerminals,
  worktreeMap,
  onActivate,
  onKill,
}: WaitingGroupItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const tabCount = waitingTerminals.length;
  const groupName = `Tab group (${tabCount} waiting)`;

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
          aria-controls={`waiting-group-${group.id}`}
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
          </div>
        </div>
      </div>

      {isExpanded && (
        <div
          id={`waiting-group-${group.id}`}
          role="region"
          aria-label="Group panels"
          className="pl-5 pr-1 pb-1.5 space-y-0.5"
        >
          {[...waitingTerminals]
            .sort((a, b) => {
              const aIndex = group.panelIds.indexOf(a.id);
              const bIndex = group.panelIds.indexOf(b.id);
              if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
              return 0;
            })
            .map((terminal) => {
              const worktreeName = terminal.worktreeId
                ? worktreeMap.get(terminal.worktreeId)?.name
                : undefined;
              return (
                <WaitingSingleItem
                  key={terminal.id}
                  terminal={terminal}
                  groupId={group.id}
                  worktreeName={worktreeName}
                  onActivate={onActivate}
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
