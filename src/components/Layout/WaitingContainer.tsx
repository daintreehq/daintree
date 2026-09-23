import { useState, useMemo, useCallback, useEffect, useId } from "react";
import { ChevronDown, ChevronRight, OctagonX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useExitLaggedCount } from "@/hooks/useExitLaggedCount";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store";
import type { PtyPanelData } from "@shared/types/panel";
import { closeAndAnnounce } from "@/lib/accessibility";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWaitingTerminals } from "@/hooks/useTerminalSelectors";
import {
  actionableWaitingReason,
  compareWaitingAttention,
  WAITING_REASON_BADGE_LABEL,
  waitingHeadline,
} from "@shared/utils/waitingReasonDisplay";
import { useWorktrees } from "@/hooks/useWorktrees";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import type { TabGroup } from "@/types";
import {
  KILL_TERMINAL_TITLE,
  KILL_TERMINAL_CONFIRM_LABEL,
  killTerminalDescription,
} from "./killTerminalStrings";
import {
  DOCK_STATUS_PILL_CLASS,
  DOCK_STATUS_PILL_OPEN_CLASS,
  DockStatusPillLabel,
  dockStatusScopeDescription,
  useDockPopoverFocusHandoff,
} from "./dockStatusPill";

interface WaitingContainerProps {
  compact?: boolean;
}

interface WaitingDisplaySingle {
  type: "single";
  terminal: PtyPanelData;
  groupId: string | null;
}

interface WaitingDisplayGroup {
  type: "group";
  group: TabGroup;
  waitingTerminals: PtyPanelData[];
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
  const focusHandoff = useDockPopoverFocusHandoff();

  const displayItems = useMemo((): WaitingDisplayItem[] => {
    // Triage order, not insertion order: approvals first, then error-blocked,
    // then questions, then plain prompts; longest-waiting first within each.
    // Deterministic tie-breaks keep rows from reshuffling between renders.
    const sortedTerminals = [...terminals].sort(compareWaitingAttention);
    // Build panelId -> group, applying the same location guard as
    // getPanelGroup so a stale group whose location no longer matches the
    // panel falls through to a single row instead of mis-routing setActiveTab.
    const panelToGroup = new Map<string, TabGroup>();
    const waitingByPanelId = new Map<string, PtyPanelData>();
    for (const terminal of sortedTerminals) waitingByPanelId.set(terminal.id, terminal);
    for (const group of tabGroups.values()) {
      for (const panelId of group.panelIds) {
        const panel = waitingByPanelId.get(panelId);
        if (!panel) continue;
        const panelLocation = panel.location === "dock" ? "dock" : "grid";
        if (panelLocation !== group.location) continue;
        panelToGroup.set(panelId, group);
      }
    }

    const groupBuckets = new Map<string, { group: TabGroup; waitingMembers: PtyPanelData[] }>();
    const singles: WaitingDisplaySingle[] = [];

    for (const terminal of sortedTerminals) {
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

    // Interleave groups and singles by their most urgent member so a lone
    // approval never sits below a tab group of plain prompts. Members are
    // already sorted, so a group's first member is its representative.
    items.sort((a, b) =>
      compareWaitingAttention(
        a.type === "group" ? a.waitingTerminals[0]! : a.terminal,
        b.type === "group" ? b.waitingTerminals[0]! : b.terminal
      )
    );

    return items;
  }, [terminals, tabGroups]);

  // The pill counts the whole project; the popover says which of it is here.
  // Urgency order holds within each section.
  const { hereItems, elsewhereItems } = useMemo(() => {
    const here: WaitingDisplayItem[] = [];
    const elsewhere: WaitingDisplayItem[] = [];
    for (const item of displayItems) {
      const worktreeId =
        item.type === "group"
          ? (item.group.worktreeId ?? item.waitingTerminals[0]?.worktreeId)
          : item.terminal.worktreeId;
      ((worktreeId ?? null) === (activeWorktreeId ?? null) ? here : elsewhere).push(item);
    }
    return { hereItems: here, elsewhereItems: elsewhere };
  }, [displayItems, activeWorktreeId]);

  const hereCount = useMemo(
    () => terminals.filter((t) => (t.worktreeId ?? null) === (activeWorktreeId ?? null)).length,
    [terminals, activeWorktreeId]
  );
  const worktreeCount = useMemo(
    () => new Set(terminals.map((t) => t.worktreeId ?? null)).size,
    [terminals]
  );

  const handleActivate = useCallback(
    (terminal: PtyPanelData, groupId: string | null) => {
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
      focusHandoff.markHandoff();
      setIsOpen(false);
    },
    [
      focusHandoff,
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
      const target = terminals.find((t) => t.id === killConfirmId);
      removePanel(killConfirmId);
      closeAndAnnounce(
        () => setKillConfirmId(null),
        target?.title ? `${target.title} killed` : "Terminal killed"
      );
      return;
    }
    setKillConfirmId(null);
  }, [killConfirmId, removePanel, terminals]);

  const count = terminals.length;
  // Lagged count keeps the label stable while the pill fades out via the
  // .dock-status-pill exit transition instead of flashing "(0)".
  const displayCount = useExitLaggedCount(count);
  const WaitingIcon = STATE_ICONS.waiting;

  useEffect(() => {
    if (count === 0) {
      setIsOpen(false);
      setKillConfirmId(null);
    }
  }, [count]);

  return (
    <span className="dock-status-pill" data-visible={count > 0 ? "true" : "false"}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="pill"
                size="sm"
                className={cn(
                  DOCK_STATUS_PILL_CLASS,
                  compact ? "px-2 min-w-0" : "px-3",
                  isOpen && DOCK_STATUS_PILL_OPEN_CLASS
                )}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls="waiting-container-popover"
                aria-label={`Waiting: ${displayCount} ${displayCount === 1 ? "agent" : "agents"} ${dockStatusScopeDescription(displayCount, hereCount)}`}
              >
                <DockStatusPillLabel
                  icon={<WaitingIcon className="text-state-waiting" aria-hidden="true" />}
                  label="Waiting"
                  count={displayCount}
                  hasLocal={hereCount > 0}
                  compact={compact}
                />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {`Agents waiting ${dockStatusScopeDescription(displayCount, hereCount)}`}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          id="waiting-container-popover"
          role="dialog"
          aria-label="Waiting panels"
          className="w-96 p-0"
          side="top"
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={focusHandoff.onCloseAutoFocus}
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
            <div className="px-3 py-2 border-b border-divider bg-surface-canvas/50 flex justify-between items-center">
              <span className="text-xs font-medium text-text-secondary">Waiting for input</span>
              <span className="text-3xs font-medium text-text-secondary tabular-nums">
                {count} {count === 1 ? "agent" : "agents"}
                {worktreeCount > 1 && ` across ${worktreeCount} worktrees`}
              </span>
            </div>

            <div className="p-1 flex flex-col gap-1 max-h-[360px] overflow-y-auto">
              {[
                { key: "here", label: "This worktree", items: hereItems },
                { key: "elsewhere", label: "Other worktrees", items: elsewhereItems },
              ].map(
                (section) =>
                  section.items.length > 0 && (
                    <div
                      key={section.key}
                      role="group"
                      aria-label={section.label}
                      className="flex shrink-0 flex-col gap-px"
                    >
                      <div
                        className="flex h-5 items-center px-2 text-3xs font-medium text-text-secondary"
                        aria-hidden="true"
                      >
                        {section.label}
                      </div>
                      {section.items.map((item) => {
                        // A row in "This worktree" doesn't repeat the worktree it's in.
                        const showWorktree = section.key === "elsewhere";
                        if (item.type === "group") {
                          return (
                            <WaitingGroupItem
                              key={item.group.id}
                              group={item.group}
                              waitingTerminals={item.waitingTerminals}
                              worktreeMap={worktreeMap}
                              showWorktree={showWorktree}
                              onActivate={handleActivate}
                              onKill={(id) => setKillConfirmId(id)}
                            />
                          );
                        }
                        const worktreeName =
                          showWorktree && item.terminal.worktreeId
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
                  )
              )}
            </div>
          </div>
        </PopoverContent>

        <ConfirmDialog
          isOpen={killConfirmId !== null}
          onClose={() => setKillConfirmId(null)}
          title={KILL_TERMINAL_TITLE}
          description={killTerminalDescription(killTarget?.title || undefined)}
          variant="destructive"
          confirmLabel={KILL_TERMINAL_CONFIRM_LABEL}
          onConfirm={handleKillConfirm}
        />
      </Popover>
    </span>
  );
}

interface WaitingSingleItemProps {
  terminal: PtyPanelData;
  groupId: string | null;
  worktreeName: string | undefined;
  onActivate: (terminal: PtyPanelData, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
}

const ROW_SURFACE_CLASS =
  "rounded-[var(--radius-sm)] transition-colors duration-150 ease-out hover:bg-overlay-subtle";

const ROW_TARGET_CLASS =
  "flex w-full min-w-0 items-center gap-2 h-7 px-2 text-left rounded-[var(--radius-sm)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2 cursor-pointer select-none";

function WaitingSingleItem({
  terminal,
  groupId,
  worktreeName,
  onActivate,
  onKill,
}: WaitingSingleItemProps) {
  const agentState = terminal.agentState;
  const title = terminal.title || "Terminal";
  // The observed task is what tells three "Claude" rows apart; it goes through
  // the shared title rules so an identity echo never renders as a task here.
  const task = getTerminalTaskTitle(terminal);
  // Only classifier-backed reasons earn a chip — the `prompt` fallback stays
  // an unlabeled row so the list doesn't overclaim.
  const reason = actionableWaitingReason(terminal.waitingReason);
  const context = [worktreeName, task].filter(Boolean).join(" · ");
  const ageId = useId();

  return (
    // The activation target and the kill button are siblings, never nested:
    // the wrapper only owns the shared hover surface and the reveal group.
    <div className={cn("group/row relative", ROW_SURFACE_CLASS)}>
      <button
        type="button"
        data-testid="waiting-single-item"
        data-agent-state={agentState ?? "unknown"}
        data-waiting-reason={terminal.waitingReason ?? "unknown"}
        onClick={() => onActivate(terminal, groupId)}
        className={ROW_TARGET_CLASS}
        aria-label={`Focus ${title}${task ? `: ${task}` : ""}${worktreeName ? ` in ${worktreeName}` : ""}${reason ? ` — ${waitingHeadline(reason).toLowerCase()}` : ""}${terminal.activityHeadline ? ` — ${terminal.activityHeadline}` : ""}`}
        aria-describedby={terminal.lastStateChange != null ? ageId : undefined}
      >
        <TerminalIcon
          kind={terminal.kind}
          chrome={deriveTerminalChrome(terminal)}
          className="h-3 w-3 shrink-0"
        />

        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 max-w-[65%] shrink-0 truncate text-xs font-medium text-text-primary">
            {title}
          </span>
          {(context || terminal.activityHeadline) && (
            <span className="min-w-0 truncate text-2xs text-text-secondary">
              {context}
              {context && terminal.activityHeadline && " · "}
              {terminal.activityHeadline && (
                <span className="italic">{terminal.activityHeadline}</span>
              )}
            </span>
          )}
        </span>

        {reason && (
          <span
            className={cn(
              "shrink-0 rounded-[var(--radius-sm)] px-1.5 py-px text-3xs font-medium",
              reason === "error"
                ? "bg-status-error/15 text-text-primary"
                : "bg-state-waiting/15 text-text-primary"
            )}
            data-testid={`waiting-reason-badge-${terminal.id}`}
          >
            {WAITING_REASON_BADGE_LABEL[reason]}
          </span>
        )}

        {/* The age holds the trailing slot at rest and yields it to the kill
            button on hover/focus, so no row reserves an empty action column. */}
        <span
          id={ageId}
          className="min-w-6 shrink-0 text-right text-3xs leading-none transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover/row:opacity-0 group-focus-within/row:opacity-0"
        >
          {terminal.lastStateChange != null && (
            <LiveTimeAgo
              timestamp={terminal.lastStateChange}
              noTooltip
              className="text-3xs text-text-secondary tabular-nums"
            />
          )}
        </span>
      </button>

      <div className="absolute inset-y-0 right-0.5 flex items-center invisible opacity-0 pointer-events-none transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none group-hover/row:visible group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:visible group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost-danger"
              size="icon-xs"
              className="transition-colors"
              onClick={() => onKill(terminal.id)}
              aria-label={`Kill ${title}${task ? `: ${task}` : ""}`}
              data-testid="waiting-kill-button"
            >
              <OctagonX aria-hidden="true" />
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
  waitingTerminals: PtyPanelData[];
  worktreeMap: ReturnType<typeof useWorktrees>["worktreeMap"];
  showWorktree: boolean;
  onActivate: (terminal: PtyPanelData, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
}

function WaitingGroupItem({
  group,
  waitingTerminals,
  worktreeMap,
  showWorktree,
  onActivate,
  onKill,
}: WaitingGroupItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const tabCount = waitingTerminals.length;
  const groupWorktreeId = group.worktreeId ?? waitingTerminals[0]?.worktreeId;
  const groupWorktreeName =
    showWorktree && groupWorktreeId ? worktreeMap.get(groupWorktreeId)?.name : undefined;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col gap-px">
      <div className={ROW_SURFACE_CLASS}>
        <button
          type="button"
          className={ROW_TARGET_CLASS}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-controls={`waiting-group-${group.id}`}
        >
          <Chevron className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 text-xs font-medium text-text-secondary">
              {`Tab group (${tabCount} waiting)`}
            </span>
            {groupWorktreeName && (
              <span className="min-w-0 truncate text-2xs text-text-secondary">
                {groupWorktreeName}
              </span>
            )}
          </span>
        </button>
      </div>

      {isExpanded && (
        <div
          id={`waiting-group-${group.id}`}
          role="region"
          aria-label="Group panels"
          className="ml-3.5 flex flex-col gap-px border-l border-divider pl-1"
        >
          {/* Members arrive attention-sorted from displayItems — rendering
              them as-is keeps the expanded group consistent with the triage
              order that promoted the group in the first place. The group
              header already names the worktree, so members don't repeat it. */}
          {waitingTerminals.map((terminal) => (
            <WaitingSingleItem
              key={terminal.id}
              terminal={terminal}
              groupId={group.id}
              worktreeName={undefined}
              onActivate={onActivate}
              onKill={onKill}
            />
          ))}
        </div>
      )}
    </div>
  );
}
