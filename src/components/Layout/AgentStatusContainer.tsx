import { useState, useMemo, useCallback, useEffect, useId, type ComponentType } from "react";
import { ChevronRight, Clock, MailOpen, OctagonX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useExitLaggedCount } from "@/hooks/useExitLaggedCount";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { handleDockEscapeKeyDown } from "./dockPopoverGuard";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store";
import type { PtyPanelData } from "@shared/types/panel";
import { closeAndAnnounce } from "@/lib/accessibility";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  actionableWaitingReason,
  WAITING_REASON_BADGE_LABEL,
  waitingHeadline,
} from "@shared/utils/waitingReasonDisplay";
import { useWorktreeNames } from "@/hooks/useWorktrees";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import type { TabGroup } from "@/types";
import {
  KILL_TERMINAL_TITLE,
  KILL_TERMINAL_CONFIRM_LABEL,
  killTerminalDescription,
} from "./killTerminalStrings";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import {
  DOCK_STATUS_PILL_CLASS,
  DOCK_STATUS_PILL_OPEN_CLASS,
  DOCK_POPOVER_HEADER_CLASS,
  DOCK_POPOVER_ROW_HOVER_CLASS,
  DOCK_POPOVER_SECTIONS,
  DockPopoverList,
  DockPopoverSection,
  DockStatusPillLabel,
  dockStatusScopeDescription,
  useDockPopoverFocusHandoff,
} from "./dockStatusPill";
import { pluralize } from "@/lib/pluralize";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { CirclePause } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PluginAttentionRow } from "@/lib/pluginPanelAttention";
import { usePluginPanelActivityStore } from "@/store/pluginPanelActivityStore";
import {
  PLUGIN_ATTENTION_SNOOZE_OPTIONS,
  usePluginPanelAttentionStore,
} from "@/store/pluginPanelAttentionStore";
import { AGENT_SNOOZE_LABEL } from "@shared/utils/agentSnoozeDurations";
import { openPluginAttentionPanel } from "@/components/PluginAttention/openPluginAttentionPanel";

/**
 * What sets one agent pill apart from another. Everything else — the triage
 * list, tab-group bucketing, the here/elsewhere split, activation and kill —
 * is the same popover, so Waiting and Unread can't drift apart.
 */
export interface AgentStatusConfig {
  /** Prefixes the popover, group and test ids, and names the group count. */
  kind: "waiting" | "unread";
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  iconClassName: string;
  /** Tooltip lead, followed by the project-wide scope. */
  tooltip: string;
  popoverLabel: string;
  heading: string;
  /**
   * Whether rows say why the agent stopped: the reason chip and the activity
   * headline, which for an agent is its state in words ("Waiting for input",
   * "Asked a question"). Off for hand-backs, which are never waiting, and a
   * question wait Canopy read as not asking is still `question` underneath.
   */
  showReasons: boolean;
  /**
   * The row's hover action. A hand-back's natural dismissal is reading it, so
   * Unread offers that and leaves Kill to the row's context menu.
   */
  rowAction: "kill" | "mark-read";
  /** Row order; groups take the place of their first member. */
  compare: (a: PtyPanelData, b: PtyPanelData) => number;
}

interface AgentStatusContainerProps {
  terminals: PtyPanelData[];
  /**
   * Plugin panels the user let into this pill (#13821). Their own section,
   * below every agent's, so a plugin can never rank above an agent asking.
   */
  pluginRows?: readonly PluginAttentionRow[];
  config: AgentStatusConfig;
  compact?: boolean;
}

const NO_PLUGIN_ROWS: readonly PluginAttentionRow[] = [];

/** Who the pill is counting, by kind: plugin panels are never called agents. */
function subjectPhrase(agents: number, plugins: number): string {
  if (plugins === 0) return pluralize(agents, "agent");
  if (agents === 0) return pluralize(plugins, "plugin panel");
  return `${pluralize(agents, "agent")}, ${pluralize(plugins, "plugin panel")}`;
}

interface AgentDisplaySingle {
  type: "single";
  terminal: PtyPanelData;
  groupId: string | null;
}

interface AgentDisplayGroup {
  type: "group";
  group: TabGroup;
  memberTerminals: PtyPanelData[];
}

type AgentDisplayItem = AgentDisplaySingle | AgentDisplayGroup;

export function AgentStatusContainer({
  terminals,
  pluginRows: reportedPluginRows = NO_PLUGIN_ROWS,
  config,
  compact = false,
}: AgentStatusContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);
  const { kind, compare } = config;
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
  const worktreeNames = useWorktreeNames();
  const focusHandoff = useDockPopoverFocusHandoff();
  // A panel left behind by a deleted worktree is not somewhere a row can take
  // the user, so it is dropped the way an orphaned terminal is.
  const pluginRows = useMemo(
    () =>
      worktreeNames.size === 0
        ? reportedPluginRows
        : reportedPluginRows.filter(
            (row) => row.worktreeId === null || worktreeNames.has(row.worktreeId)
          ),
    [reportedPluginRows, worktreeNames]
  );

  const displayItems = useMemo((): AgentDisplayItem[] => {
    // The pill's own triage order, not insertion order. Deterministic
    // tie-breaks keep rows from reshuffling between renders.
    const sortedTerminals = [...terminals].sort(compare);
    // Build panelId -> group, applying the same location guard as
    // getPanelGroup so a stale group whose location no longer matches the
    // panel falls through to a single row instead of mis-routing setActiveTab.
    const panelToGroup = new Map<string, TabGroup>();
    const memberByPanelId = new Map<string, PtyPanelData>();
    for (const terminal of sortedTerminals) memberByPanelId.set(terminal.id, terminal);
    for (const group of tabGroups.values()) {
      for (const panelId of group.panelIds) {
        const panel = memberByPanelId.get(panelId);
        if (!panel) continue;
        const panelLocation = panel.location === "dock" ? "dock" : "grid";
        if (panelLocation !== group.location) continue;
        panelToGroup.set(panelId, group);
      }
    }

    const groupBuckets = new Map<string, { group: TabGroup; members: PtyPanelData[] }>();
    const singles: AgentDisplaySingle[] = [];

    for (const terminal of sortedTerminals) {
      const group = panelToGroup.get(terminal.id);
      if (group) {
        const bucket = groupBuckets.get(group.id);
        if (bucket) {
          bucket.members.push(terminal);
        } else {
          groupBuckets.set(group.id, { group, members: [terminal] });
        }
      } else {
        singles.push({ type: "single", terminal, groupId: null });
      }
    }

    const items: AgentDisplayItem[] = [];

    for (const { group, members } of groupBuckets.values()) {
      if (members.length > 1) {
        items.push({ type: "group", group, memberTerminals: members });
      } else {
        for (const terminal of members) {
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
      compare(
        a.type === "group" ? a.memberTerminals[0]! : a.terminal,
        b.type === "group" ? b.memberTerminals[0]! : b.terminal
      )
    );

    return items;
  }, [terminals, tabGroups, compare]);

  // The pill counts the whole project; the popover says which of it is here.
  // Urgency order holds within each section.
  const { hereItems, elsewhereItems } = useMemo(() => {
    const here: AgentDisplayItem[] = [];
    const elsewhere: AgentDisplayItem[] = [];
    for (const item of displayItems) {
      const worktreeId =
        item.type === "group"
          ? (item.group.worktreeId ?? item.memberTerminals[0]?.worktreeId)
          : item.terminal.worktreeId;
      // An `if`, not `(cond ? here : elsewhere).push`: the compiler can't lower
      // a `??` inside a ternary's test and bails the whole component.
      if ((worktreeId ?? null) === (activeWorktreeId ?? null)) here.push(item);
      else elsewhere.push(item);
    }
    return { hereItems: here, elsewhereItems: elsewhere };
  }, [displayItems, activeWorktreeId]);

  const hereCount = useMemo(
    () =>
      terminals.filter((t) => (t.worktreeId ?? null) === (activeWorktreeId ?? null)).length +
      pluginRows.filter((row) => row.worktreeId === (activeWorktreeId ?? null)).length,
    [terminals, pluginRows, activeWorktreeId]
  );
  const worktreeCount = useMemo(
    () =>
      new Set([
        ...terminals.map((t) => t.worktreeId ?? null),
        ...pluginRows.map((row) => row.worktreeId),
      ]).size,
    [terminals, pluginRows]
  );

  const handleActivatePlugin = useCallback(
    (row: PluginAttentionRow) => {
      focusHandoff.markHandoff();
      setIsOpen(false);
      safeFireAndForget(openPluginAttentionPanel(row.panelId), {
        context: "AgentStatusContainer openPluginAttentionPanel",
      });
    },
    [focusHandoff]
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

  const count = terminals.length + pluginRows.length;
  const subject = subjectPhrase(terminals.length, pluginRows.length);
  // Lagged count keeps the label stable while the pill fades out via the
  // .dock-status-pill exit transition instead of flashing "(0)".
  const displayCount = useExitLaggedCount(count);
  const popoverId = `${kind}-container-popover`;

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
                aria-controls={popoverId}
                onClick={focusHandoff.onTriggerClick}
                aria-label={`${config.label}: ${pluginRows.length === 0 ? pluralize(displayCount, "agent") : subject} ${dockStatusScopeDescription(displayCount, hereCount)}`}
              >
                <DockStatusPillLabel
                  icon={<config.Icon className={config.iconClassName} aria-hidden="true" />}
                  label={config.label}
                  count={displayCount}
                  hasLocal={hereCount > 0}
                  compact={compact}
                />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {pluginRows.length === 0
              ? `${config.tooltip} ${dockStatusScopeDescription(displayCount, hereCount)}`
              : `${config.label}: ${subject} ${dockStatusScopeDescription(displayCount, hereCount)}`}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          id={popoverId}
          role="dialog"
          aria-label={config.popoverLabel}
          className="w-96 p-0"
          side="top"
          align="end"
          onOpenAutoFocus={focusHandoff.onOpenAutoFocus}
          onCloseAutoFocus={focusHandoff.onCloseAutoFocus}
          onKeyDown={focusHandoff.onContentKeyDown}
          onPointerDownOutside={(e) => {
            if (killConfirmId !== null) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (killConfirmId !== null) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (killConfirmId === null) return;
            e.preventDefault();
            // Blocking alone left Escape closing nothing: AppDialog's backstop
            // stands down while this popover is open unless the keypress is
            // handed to the focused dialog.
            handleDockEscapeKeyDown(e, null);
          }}
        >
          <div className="flex flex-col">
            <div className={DOCK_POPOVER_HEADER_CLASS}>
              <span className="text-xs font-medium text-text-secondary">{config.heading}</span>
              <span className="text-3xs font-medium text-text-secondary tabular-nums">
                {subject}
                {worktreeCount > 1 && ` across ${worktreeCount} worktrees`}
              </span>
            </div>

            <DockPopoverList>
              {DOCK_POPOVER_SECTIONS.map((section) => {
                const items = section.key === "here" ? hereItems : elsewhereItems;
                if (items.length === 0) return null;
                // A row in "This worktree" doesn't repeat the worktree it's in.
                const showWorktree = section.key === "elsewhere";
                return (
                  <DockPopoverSection key={section.key} label={section.label}>
                    {items.map((item) => {
                      if (item.type === "group") {
                        return (
                          <AgentGroupItem
                            key={item.group.id}
                            kind={kind}
                            showReasons={config.showReasons}
                            rowAction={config.rowAction}
                            group={item.group}
                            memberTerminals={item.memberTerminals}
                            worktreeNames={worktreeNames}
                            showWorktree={showWorktree}
                            onActivate={handleActivate}
                            onKill={(id) => setKillConfirmId(id)}
                          />
                        );
                      }
                      const worktreeName =
                        showWorktree && item.terminal.worktreeId
                          ? worktreeNames.get(item.terminal.worktreeId)
                          : undefined;
                      return (
                        <AgentSingleItem
                          key={item.terminal.id}
                          kind={kind}
                          showReasons={config.showReasons}
                          rowAction={config.rowAction}
                          terminal={item.terminal}
                          groupId={item.groupId}
                          worktreeName={worktreeName}
                          onActivate={handleActivate}
                          onKill={(id) => setKillConfirmId(id)}
                        />
                      );
                    })}
                  </DockPopoverSection>
                );
              })}
              {pluginRows.length > 0 && (
                <DockPopoverSection label="Plugin panels">
                  {pluginRows.map((row) => (
                    <PluginAttentionItem
                      key={row.panelId}
                      kind={kind}
                      row={row}
                      worktreeName={
                        row.worktreeId !== null && row.worktreeId !== (activeWorktreeId ?? null)
                          ? worktreeNames.get(row.worktreeId)
                          : undefined
                      }
                      onActivate={handleActivatePlugin}
                    />
                  ))}
                </DockPopoverSection>
              )}
            </DockPopoverList>
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

interface AgentSingleItemProps {
  kind: AgentStatusConfig["kind"];
  showReasons: boolean;
  rowAction: AgentStatusConfig["rowAction"];
  terminal: PtyPanelData;
  groupId: string | null;
  worktreeName: string | undefined;
  /** False inside a group whose header already shows the worktree; it stays in the accessible name. */
  showWorktreeInline?: boolean;
  onActivate: (terminal: PtyPanelData, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
}

const ROW_SURFACE_CLASS = cn("rounded-[var(--radius-sm)]", DOCK_POPOVER_ROW_HOVER_CLASS);

const ROW_TARGET_CLASS =
  "flex w-full min-w-0 items-center gap-2 h-7 px-2 text-left rounded-[var(--radius-sm)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2 cursor-pointer select-none";

function AgentSingleItem({
  kind,
  showReasons,
  rowAction,
  terminal,
  groupId,
  worktreeName,
  showWorktreeInline = true,
  onActivate,
  onKill,
}: AgentSingleItemProps) {
  const agentState = terminal.agentState;
  const title = terminal.title || "Terminal";
  // The observed task is what tells three "Claude" rows apart; it goes through
  // the shared title rules so an identity echo never renders as a task here.
  const task = getTerminalTaskTitle(terminal);
  // Only classifier-backed reasons earn a chip — the `prompt` fallback stays
  // an unlabeled row so the list doesn't overclaim.
  const reason = showReasons ? actionableWaitingReason(terminal.waitingReason) : null;
  const headline = showReasons ? terminal.activityHeadline : undefined;
  const context = [showWorktreeInline ? worktreeName : undefined, task].filter(Boolean).join(" · ");
  const ageId = useId();
  // The arrows land on the row's button, never on its text, so a clipped title
  // or context shows its full text while the row holds keyboard focus.
  const [revealClipped, setRevealClipped] = useState(false);

  return (
    // The activation target and the row action are siblings, never nested:
    // the wrapper only owns the shared hover surface and the reveal group.
    // Right-click is this row's panel, the same menu its dock chip or pane
    // header opens — never the popover's or the active panel's.
    <TerminalContextMenu terminalId={terminal.id} proxy>
      <div data-dock-row="" className={cn("group/row relative", ROW_SURFACE_CLASS)}>
        <button
          type="button"
          data-testid={`${kind}-single-item`}
          data-agent-state={agentState ?? "unknown"}
          data-waiting-reason={terminal.waitingReason ?? "unknown"}
          onClick={() => onActivate(terminal, groupId)}
          className={ROW_TARGET_CLASS}
          aria-label={`Focus ${title}${task ? `: ${task}` : ""}${worktreeName ? ` in ${worktreeName}` : ""}${reason ? ` — ${waitingHeadline(reason).toLowerCase()}` : ""}${headline ? ` — ${headline}` : ""}`}
          aria-describedby={terminal.lastStateChange != null ? ageId : undefined}
          onFocus={(e) => setRevealClipped(e.currentTarget.matches(":focus-visible"))}
          onBlur={() => setRevealClipped(false)}
        >
          <TerminalIcon
            kind={terminal.kind}
            chrome={deriveTerminalChrome(terminal)}
            className="h-3 w-3 shrink-0"
          />

          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            {/* The name keeps its own width and the context takes what is
                left; only a name long enough to crowd the context below 4rem
                gives way, so a lone long title runs the full row. */}
            <TruncatedTooltip
              content={title}
              focusable={false}
              open={revealClipped || undefined}
              onOpenChange={(open) => !open && setRevealClipped(false)}
              side="top"
              align="start"
            >
              <span className="min-w-0 truncate text-xs font-medium text-text-primary">
                {title}
              </span>
            </TruncatedTooltip>
            {(context || headline) && (
              <TruncatedTooltip
                content={[context, headline].filter(Boolean).join(" · ")}
                focusable={false}
                open={revealClipped || undefined}
                onOpenChange={(open) => !open && setRevealClipped(false)}
                side="bottom"
                align="start"
              >
                <span className="min-w-16 flex-1 basis-0 truncate text-xs text-text-secondary">
                  {context}
                  {context && headline && " · "}
                  {headline && <span className="italic">{headline}</span>}
                </span>
              </TruncatedTooltip>
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
            className="min-w-6 shrink-0 text-right text-3xs leading-none transition-opacity duration-150 ease-out group-hover/row:opacity-0 group-focus-within/row:opacity-0"
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

        <div className="absolute inset-y-0 right-0.5 flex items-center pointer-events-none invisible opacity-0 transition-[opacity,visibility] duration-150 ease-out group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100">
          {rowAction === "mark-read" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-events-auto transition-colors"
                  onClick={() =>
                    safeFireAndForget(window.electron.fleet.markRunRead(terminal.id), {
                      context: "AgentStatusContainer markRunRead",
                    })
                  }
                  aria-label={`Mark ${title}${task ? `: ${task}` : ""} as read`}
                  data-testid={`${kind}-mark-read-button`}
                >
                  <MailOpen aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Mark as read</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost-danger"
                  size="icon-sm"
                  className="pointer-events-auto transition-colors"
                  onClick={() => onKill(terminal.id)}
                  aria-label={`Kill ${title}${task ? `: ${task}` : ""}`}
                  data-testid={`${kind}-kill-button`}
                >
                  <OctagonX aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{`Kill ${title}`}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TerminalContextMenu>
  );
}

interface AgentGroupItemProps {
  kind: AgentStatusConfig["kind"];
  showReasons: boolean;
  rowAction: AgentStatusConfig["rowAction"];
  group: TabGroup;
  memberTerminals: PtyPanelData[];
  worktreeNames: ReadonlyMap<string, string>;
  showWorktree: boolean;
  onActivate: (terminal: PtyPanelData, groupId: string | null) => void;
  onKill: (terminalId: string) => void;
}

function AgentGroupItem({
  kind,
  showReasons,
  rowAction,
  group,
  memberTerminals,
  worktreeNames,
  showWorktree,
  onActivate,
  onKill,
}: AgentGroupItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const tabCount = memberTerminals.length;
  const groupWorktreeId = group.worktreeId ?? memberTerminals[0]?.worktreeId;
  const groupWorktreeName =
    showWorktree && groupWorktreeId ? worktreeNames.get(groupWorktreeId) : undefined;
  const headerId = useId();

  return (
    <div className="flex flex-col gap-px">
      <div data-dock-row="" className={ROW_SURFACE_CLASS}>
        <button
          id={headerId}
          type="button"
          className={ROW_TARGET_CLASS}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-controls={`${kind}-group-${group.id}`}
        >
          <ChevronRight
            data-animated-chevron
            className={cn(
              "h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
              isExpanded && "rotate-90"
            )}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 text-xs font-medium text-text-secondary">
              {`Tab group (${tabCount} ${kind})`}
            </span>
            {groupWorktreeName && (
              <span className="min-w-0 truncate text-xs text-text-secondary">
                {groupWorktreeName}
              </span>
            )}
          </span>
        </button>
      </div>

      {isExpanded && (
        <div
          id={`${kind}-group-${group.id}`}
          role="region"
          aria-labelledby={headerId}
          className="ml-3.5 flex flex-col gap-px border-l border-divider pl-1"
        >
          {/* Members arrive attention-sorted from displayItems — rendering
              them as-is keeps the expanded group consistent with the triage
              order that promoted the group in the first place. */}
          {memberTerminals.map((terminal) => (
            <AgentSingleItem
              key={terminal.id}
              kind={kind}
              showReasons={showReasons}
              rowAction={rowAction}
              terminal={terminal}
              groupId={group.id}
              worktreeName={
                showWorktree && terminal.worktreeId
                  ? worktreeNames.get(terminal.worktreeId)
                  : undefined
              }
              showWorktreeInline={false}
              onActivate={onActivate}
              onKill={onKill}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const MENU_ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

interface PluginAttentionItemProps {
  kind: AgentStatusConfig["kind"];
  row: PluginAttentionRow;
  /** Set only when the panel lives in another worktree. */
  worktreeName: string | undefined;
  onActivate: (row: PluginAttentionRow) => void;
}

/**
 * A plugin panel's row: its title, then whose report it is and what it says.
 * Never a terminal's menu — park, snooze and read here are the plugin row's
 * own, held in this view, and touch no agent's.
 */
function PluginAttentionItem({ kind, row, worktreeName, onActivate }: PluginAttentionItemProps) {
  const context = [worktreeName, row.description].filter(Boolean).join(" · ");
  const isUnread = row.band === "review";
  const park = () =>
    usePluginPanelAttentionStore.getState().park(row.panelId, row.pluginId, row.revision);
  const markRead = () => usePluginPanelActivityStore.getState().markSeen(row.panelId, row.revision);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-dock-row="" className={cn("group/row relative", ROW_SURFACE_CLASS)}>
          <button
            type="button"
            data-testid={`${kind}-plugin-item`}
            data-plugin-attention={row.shown}
            onClick={() => onActivate(row)}
            className={ROW_TARGET_CLASS}
            aria-label={`Open ${row.title}${worktreeName ? ` in ${worktreeName}` : ""} — ${row.description}`}
          >
            <TerminalIcon
              kind={row.kind}
              chrome={deriveTerminalChrome({ kind: row.kind })}
              className="h-3 w-3 shrink-0"
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <TruncatedTooltip content={row.title} focusable={false} side="top" align="start">
                <span className="min-w-0 truncate text-xs font-medium text-text-primary">
                  {row.title}
                </span>
              </TruncatedTooltip>
              <TruncatedTooltip content={context} focusable={false} side="bottom" align="start">
                <span className="min-w-16 flex-1 basis-0 truncate text-xs text-text-secondary">
                  {context}
                </span>
              </TruncatedTooltip>
            </span>
          </button>

          <div className="absolute inset-y-0 right-0.5 flex items-center pointer-events-none invisible opacity-0 transition-[opacity,visibility] duration-150 ease-out group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-events-auto transition-colors"
                  onClick={isUnread ? markRead : park}
                  aria-label={isUnread ? `Mark ${row.title} as read` : `Park ${row.title}`}
                  data-testid={isUnread ? `${kind}-plugin-mark-read` : `${kind}-plugin-park`}
                >
                  {isUnread ? <MailOpen aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isUnread ? "Mark as read" : "Park until it changes"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </ContextMenuTrigger>
      {/* No "Open panel" entry: the row itself opens it, and opening from here
          would race the menu's focus restore against the panel taking focus. */}
      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Clock className={MENU_ICON_CLASS} aria-hidden="true" />
            Snooze
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {PLUGIN_ATTENTION_SNOOZE_OPTIONS.map((option) => (
              <ContextMenuItem
                key={option}
                onSelect={() =>
                  usePluginPanelAttentionStore.getState().snooze(row.panelId, row.pluginId, option)
                }
              >
                <Clock className={MENU_ICON_CLASS} aria-hidden="true" />
                {AGENT_SNOOZE_LABEL[option]}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={park}>
          <CirclePause className={MENU_ICON_CLASS} aria-hidden="true" />
          Park until it changes
        </ContextMenuItem>
        {isUnread && (
          <ContextMenuItem onSelect={markRead}>
            <MailOpen className={MENU_ICON_CLASS} aria-hidden="true" />
            Mark as read
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
