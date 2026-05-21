import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, Bell, CheckCheck, Ellipsis, Layers, Moon, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import { muteForDuration, muteUntilNextMorning, notify, setSessionQuietUntil } from "@/lib/notify";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isScheduledQuietNow, nextOccurrenceTimestamp } from "@shared/utils/quietHours";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import type { NotificationType } from "@/store/notificationStore";

const SEVERITY_WEIGHTS: Record<NotificationType, number> = {
  error: 3,
  warning: 2,
  info: 1,
  success: 0,
} as const;

const NEEDS_ATTENTION_CAP = 5;
const CONTEXT_NONE_KEY = "__none__";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function getWorstSeverity(entries: NotificationHistoryEntry[]): NotificationType {
  if (entries.length === 0) return "success";
  return entries.reduce((highest, current) =>
    SEVERITY_WEIGHTS[current.type] > SEVERITY_WEIGHTS[highest.type] ? current : highest
  ).type;
}

function isUnreadGroup(group: ThreadGroup): boolean {
  return group.entries.some((e) => !e.seenAsToast);
}

function getGroupContextKey(group: ThreadGroup): string {
  for (const e of group.entries) {
    const wt = e.context?.worktreeId;
    if (wt) return `wt:${wt}`;
    const proj = e.context?.projectId;
    if (proj) return `proj:${proj}`;
  }
  return CONTEXT_NONE_KEY;
}

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

interface ThreadGroup {
  correlationId: string | undefined;
  entries: NotificationHistoryEntry[];
  latestTimestamp: number;
}

interface ContextSection {
  key: string;
  worktreeId?: string;
  projectId?: string;
  groups: ThreadGroup[];
}

type NotificationAction = NonNullable<NotificationHistoryEntry["actions"]>[number];

interface FlatRow {
  key: string;
  isThread: boolean;
  correlationId: string | undefined;
  entryId: string;
  primaryAction: NotificationAction | undefined;
}

function buildFlatRow(group: ThreadGroup): FlatRow {
  const isThread = !!group.correlationId && group.entries.length > 1;
  const latest = group.entries[0]!;
  return {
    key: group.correlationId ?? latest.id,
    isThread,
    correlationId: group.correlationId,
    entryId: latest.id,
    primaryAction: latest.actions?.[0],
  };
}

function groupByCorrelationId(entries: NotificationHistoryEntry[]): ThreadGroup[] {
  const groups = new Map<string, { entries: NotificationHistoryEntry[]; isSolo: boolean }>();
  const order: string[] = [];

  for (const entry of entries) {
    if (entry.correlationId) {
      if (!groups.has(entry.correlationId)) {
        groups.set(entry.correlationId, { entries: [], isSolo: false });
        order.push(entry.correlationId);
      }
      groups.get(entry.correlationId)!.entries.push(entry);
    } else {
      groups.set(entry.id, { entries: [entry], isSolo: true });
      order.push(entry.id);
    }
  }

  return order.map((key) => {
    const { entries: groupEntries, isSolo } = groups.get(key)!;
    return {
      correlationId: isSolo ? undefined : key,
      entries: groupEntries,
      latestTimestamp: Math.max(...groupEntries.map((e) => e.timestamp)),
    };
  });
}

function partitionByContext(groups: ThreadGroup[]): ContextSection[] {
  const sections = new Map<string, ContextSection>();
  const order: string[] = [];

  for (const g of groups) {
    const key = getGroupContextKey(g);
    if (!sections.has(key)) {
      const first = g.entries.find((e) => e.context?.worktreeId || e.context?.projectId);
      sections.set(key, {
        key,
        worktreeId: first?.context?.worktreeId,
        projectId: first?.context?.projectId,
        groups: [],
      });
      order.push(key);
    }
    sections.get(key)!.groups.push(g);
  }

  return order.map((k) => sections.get(k)!);
}

export function NotificationCenter({ open, onClose }: NotificationCenterProps) {
  const entries = useNotificationHistoryStore((s) => s.entries);
  const unreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const markIdsRead = useNotificationHistoryStore((s) => s.markIdsRead);
  const markUnseenAsToast = useNotificationHistoryStore((s) => s.markUnseenAsToast);
  const dismissEntry = useNotificationHistoryStore((s) => s.dismissEntry);
  const dismissByCorrelationId = useNotificationHistoryStore((s) => s.dismissByCorrelationId);
  const archiveEntry = useNotificationHistoryStore((s) => s.archiveEntry);
  const archiveByCorrelationId = useNotificationHistoryStore((s) => s.archiveByCorrelationId);

  const {
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
    groupByContext,
    setGroupByContext,
  } = useNotificationSettingsStore(
    useShallow((s) => ({
      quietUntil: s.quietUntil,
      quietHoursEnabled: s.quietHoursEnabled,
      quietHoursStartMin: s.quietHoursStartMin,
      quietHoursEndMin: s.quietHoursEndMin,
      quietHoursWeekdays: s.quietHoursWeekdays,
      groupByContext: s.groupByContext,
      setGroupByContext: s.setGroupByContext,
    }))
  );

  const lastClosedAt = useUIStore((s) => s.lastNotificationCenterClosedAt);
  const resetLastClosedAt = useUIStore((s) => s.resetNotificationCenterLastClosedAt);

  const [filter, setFilter] = useState<"all" | "unread" | "archived">("all");
  const [frozenUnreadIds, setFrozenUnreadIds] = useState<Set<string> | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [dividerEl, setDividerEl] = useState<HTMLDivElement | null>(null);
  const [showJumpPill, setShowJumpPill] = useState(false);
  const prevShowJumpPillRef = useRef(false);

  // Re-render at session-mute expiry and at scheduled quiet-hours boundaries —
  // mirrors the toolbar bell pattern so the pill auto-clears without an
  // unrelated render trigger.
  const [, forceTick] = useState(0);
  const now = Date.now();
  const isSessionMuted = quietUntil > now;
  const isScheduledMuted = isScheduledQuietNow({
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
  });
  const showMutedPill = isSessionMuted || isScheduledMuted;

  useEffect(() => {
    if (!open) {
      setFrozenUnreadIds(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const tick = () => forceTick((n) => n + 1);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];

    if (isSessionMuted) {
      const delay = Math.max(0, quietUntil - Date.now());
      timeouts.push(setTimeout(tick, delay + 50));
    }

    if (quietHoursEnabled) {
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      timeouts.push(
        setTimeout(() => {
          tick();
          intervals.push(setInterval(tick, 60_000));
        }, msToNextMinute + 50)
      );
    }

    return () => {
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
    };
  }, [open, isSessionMuted, quietUntil, quietHoursEnabled]);

  useEffect(() => {
    if (!scrollContainer || !dividerEl || typeof IntersectionObserver === "undefined") {
      setShowJumpPill(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShowJumpPill(false);
            continue;
          }
          // Only show pill when divider has scrolled BELOW the viewport.
          // If divider is above the top, the user has scrolled past unread
          // content intentionally — don't summon them back.
          const rootBounds = entry.rootBounds;
          if (!rootBounds) {
            setShowJumpPill(false);
            continue;
          }
          setShowJumpPill(entry.boundingClientRect.top > rootBounds.bottom);
        }
      },
      { root: scrollContainer, threshold: 0 }
    );
    observer.observe(dividerEl);
    return () => observer.disconnect();
  }, [scrollContainer, dividerEl]);

  useEffect(() => {
    if (showJumpPill && !prevShowJumpPillRef.current) {
      useAnnouncerStore.getState().announce("New notifications below", "polite");
    }
    prevShowJumpPillRef.current = showJumpPill;
  }, [showJumpPill]);

  const filteredEntries = useMemo(() => {
    if (filter === "archived") {
      return entries.filter((e) => e.archivedAt !== null);
    }
    if (filter === "all") {
      // Archived entries belong to the Archived tab only — they're done.
      return entries.filter((e) => e.archivedAt === null);
    }
    if (frozenUnreadIds) {
      return entries.filter(
        (e) => e.archivedAt === null && (!e.seenAsToast || frozenUnreadIds.has(e.id))
      );
    }
    return entries.filter((e) => e.archivedAt === null && !e.seenAsToast);
  }, [entries, filter, frozenUnreadIds]);

  const { needsAttentionGroups, chronoSections, dividerGroupId } = useMemo(() => {
    // Pinned reflects the global unread severe-threads set so it stays the
    // same in All and Unread filter views. Hidden in Archived — pinned is for
    // active items only. Chrono respects the active filter.
    const pinned =
      filter === "archived"
        ? []
        : groupByCorrelationId(entries.filter((e) => e.archivedAt === null))
            .filter((g) => {
              if (!isUnreadGroup(g)) return false;
              const sev = getWorstSeverity(g.entries);
              return sev === "error" || sev === "warning";
            })
            .sort((a, b) => {
              const sevDiff =
                SEVERITY_WEIGHTS[getWorstSeverity(b.entries)] -
                SEVERITY_WEIGHTS[getWorstSeverity(a.entries)];
              if (sevDiff !== 0) return sevDiff;
              return b.latestTimestamp - a.latestTimestamp;
            })
            .slice(0, NEEDS_ATTENTION_CAP);

    const chronoGroups = groupByCorrelationId(filteredEntries);
    const sections: ContextSection[] = groupByContext
      ? partitionByContext(chronoGroups)
      : [{ key: "all", groups: chronoGroups }];

    let divider: string | null = null;
    if (lastClosedAt > 0 && filter !== "archived") {
      for (const g of chronoGroups) {
        if (g.latestTimestamp > lastClosedAt) {
          divider = g.correlationId ?? g.entries[0]?.id ?? null;
          break;
        }
      }
    }

    return {
      needsAttentionGroups: pinned,
      chronoSections: sections,
      dividerGroupId: divider,
    };
  }, [entries, filteredEntries, groupByContext, lastClosedAt, filter]);

  const totalChronoGroups = chronoSections.reduce((sum, s) => sum + s.groups.length, 0);

  const markIdsReadWithUndo = (requestedIds: string[], options: { resetLastClosed: boolean }) => {
    if (requestedIds.length === 0) return;
    // Re-filter against live store state so a rapid second click on a stale
    // closure doesn't fire a ghost toast for entries already marked read.
    const liveEntries = useNotificationHistoryStore.getState().entries;
    const liveById = new Map(liveEntries.map((e) => [e.id, e] as const));
    const ids = requestedIds.filter((id) => {
      const entry = liveById.get(id);
      return entry !== undefined && !entry.seenAsToast;
    });
    if (ids.length === 0) return;
    markIdsRead(ids);
    const prevLastClosedAt = options.resetLastClosed
      ? useUIStore.getState().lastNotificationCenterClosedAt
      : undefined;
    if (options.resetLastClosed) {
      resetLastClosedAt();
    }
    notify({
      type: "success",
      message: `Marked ${ids.length} as read`,
      // WCAG 2.2.1: the 5 s auto-dismiss is permitted under the "available
      // elsewhere without a time limit" exception — the notification history
      // inbox is always accessible as the recovery surface, and Undo provides
      // a reversal mechanism within the time limit.
      duration: 5000,
      priority: "high",
      // Time-bound undo — surface even during quiet hours so the user has a
      // recovery path.
      urgent: true,
      // Confirmation toast only — no inbox entry. (Don't pair with `context`:
      // notify warns and silently drops in DEV.)
      transient: true,
      action: {
        label: "Undo",
        onClick: () => {
          for (const id of ids) {
            markUnseenAsToast(id, { silent: true });
          }
          if (prevLastClosedAt !== undefined) {
            useUIStore.setState({ lastNotificationCenterClosedAt: prevLastClosedAt });
          }
        },
      },
    });
  };

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const g of needsAttentionGroups) {
      rows.push(buildFlatRow(g));
    }
    for (const section of chronoSections) {
      for (const g of section.groups) {
        rows.push(buildFlatRow(g));
      }
    }
    return rows;
  }, [needsAttentionGroups, chronoSections]);

  const rowCount = flatRows.length;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const dropdownOpenCountRef = useRef(0);
  const prevRowCountRef = useRef(rowCount);

  const setRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(index, el);
    } else {
      rowRefs.current.delete(index);
    }
  }, []);

  const handleDropdownOpenChange = useCallback((open: boolean) => {
    dropdownOpenCountRef.current = Math.max(0, dropdownOpenCountRef.current + (open ? 1 : -1));
  }, []);

  // After any row count change, clamp focusedIndex; reset the dropdown
  // counter (a row removed mid-menu may never fire onOpenChange(false)); and
  // when row count *decreases* with focus dropped to <body> (the focused row
  // just unmounted), snap focus back to the surviving slot at the prior
  // index. Only on decrease — never on mount or addition — to avoid
  // hijacking focus from the toolbar bell button when the panel opens.
  useEffect(() => {
    const prevRowCount = prevRowCountRef.current;
    prevRowCountRef.current = rowCount;

    dropdownOpenCountRef.current = 0;

    if (rowCount === 0) {
      if (focusedIndex !== 0) setFocusedIndex(0);
      return;
    }

    const clamped = Math.min(focusedIndex, rowCount - 1);
    if (clamped !== focusedIndex) {
      setFocusedIndex(clamped);
    }

    if (rowCount >= prevRowCount) return;
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rowRefs.current.get(clamped)?.focus();
  }, [rowCount, focusedIndex]);

  const dispatchPrimaryAction = useCallback((row: FlatRow) => {
    const action = row.primaryAction;
    if (!action) return;
    const manifest = actionService.get(action.actionId as ActionId);
    if (!manifest || !manifest.enabled) return;
    void actionService.dispatch(action.actionId as ActionId, action.actionArgs);
  }, []);

  const archiveRow = useCallback(
    (row: FlatRow) => {
      if (row.isThread && row.correlationId) {
        archiveByCorrelationId(row.correlationId);
      } else {
        archiveEntry(row.entryId);
      }
    },
    [archiveByCorrelationId, archiveEntry]
  );

  const moveFocusTo = useCallback((index: number) => {
    const target = rowRefs.current.get(index);
    if (target) {
      target.focus();
    }
    setFocusedIndex(index);
  }, []);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (dropdownOpenCountRef.current > 0) return;
      if (rowCount === 0) return;

      const active = document.activeElement;
      let activeIndex = -1;
      for (const [idx, el] of rowRefs.current.entries()) {
        if (el === active) {
          activeIndex = idx;
          break;
        }
      }
      if (activeIndex === -1) return;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          moveFocusTo(Math.min(activeIndex + 1, rowCount - 1));
          return;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          moveFocusTo(Math.max(activeIndex - 1, 0));
          return;
        }
        case "Home": {
          e.preventDefault();
          moveFocusTo(0);
          return;
        }
        case "End": {
          e.preventDefault();
          moveFocusTo(rowCount - 1);
          return;
        }
        case "e": {
          e.preventDefault();
          const row = flatRows[activeIndex];
          if (!row) return;
          // In the Archived tab, 'e' permanently deletes the visible (head)
          // entry. Do NOT route threads through dismissByCorrelationId — a
          // live entry sharing the same correlationId would also be destroyed.
          if (filter === "archived") {
            dismissEntry(row.entryId);
          } else {
            archiveRow(row);
          }
          return;
        }
        case "Enter": {
          const row = flatRows[activeIndex];
          if (!row || !row.primaryAction) return;
          e.preventDefault();
          dispatchPrimaryAction(row);
          return;
        }
        default:
          return;
      }
    },
    [rowCount, flatRows, moveFocusTo, dismissEntry, archiveRow, dispatchPrimaryAction, filter]
  );

  const handleMarkAllRead = () => {
    // Archived entries are already done; they must never appear in the
    // mark-all-read undo set or the "Marked N as read" count.
    const ids = entries.filter((e) => !e.seenAsToast && !e.archivedAt).map((e) => e.id);
    if (filter === "unread") {
      setFrozenUnreadIds(new Set(ids));
    }
    markIdsReadWithUndo(ids, { resetLastClosed: true });
  };

  const handleMuteFor = (durationMs: number) => {
    muteForDuration(durationMs);
  };

  const handleMuteUntilMorning = () => {
    muteUntilNextMorning();
  };

  const openNotificationSettings = () => {
    onClose();
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "notifications" },
      { source: "user" }
    );
  };

  const handleResumeNotifications = () => {
    setSessionQuietUntil(0);
  };

  const pillLabel = isSessionMuted
    ? `Muted until ${timeFormatter.format(new Date(quietUntil))}`
    : "Quiet hours";
  const morningLabel = `Until ${timeFormatter.format(new Date(nextOccurrenceTimestamp(8 * 60)))}`;
  const mutedEmptyDescription = (() => {
    if (isScheduledMuted) {
      const scheduledEnd = nextOccurrenceTimestamp(quietHoursEndMin);
      // When both mutes overlap, the later end-time is what actually unblocks
      // notifications — show that, not the session-mute expiry.
      if (!isSessionMuted || scheduledEnd > quietUntil) {
        return `Quiet hours active. Resuming at ${timeFormatter.format(new Date(scheduledEnd))}`;
      }
    }
    return `Resuming at ${timeFormatter.format(new Date(quietUntil))}`;
  })();

  const showGroupToggle = entries.length > 0;

  return (
    <div className="w-[360px] max-h-[420px] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-daintree-text/80">Notifications</span>
          {entries.length > 0 && (
            <>
              <button
                type="button"
                aria-pressed={filter === "all"}
                onClick={() => {
                  setFilter("all");
                  setFrozenUnreadIds(null);
                }}
                className={cn(
                  "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full transition-colors",
                  filter === "all"
                    ? "bg-filter-selected-bg-strong text-daintree-text font-medium"
                    : "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.04]"
                )}
              >
                All
              </button>
              <button
                type="button"
                aria-pressed={filter === "unread"}
                onClick={() => setFilter("unread")}
                className={cn(
                  "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full transition-colors",
                  filter === "unread"
                    ? "bg-filter-selected-bg-strong text-daintree-text font-medium"
                    : "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.04]"
                )}
              >
                Unread
              </button>
              <button
                type="button"
                aria-pressed={filter === "archived"}
                onClick={() => {
                  setFilter("archived");
                  setFrozenUnreadIds(null);
                }}
                className={cn(
                  "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full transition-colors",
                  filter === "archived"
                    ? "bg-filter-selected-bg-strong text-daintree-text font-medium"
                    : "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.04]"
                )}
              >
                Archived
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {showGroupToggle && (
            <button
              type="button"
              aria-label="Group by project or worktree"
              aria-pressed={groupByContext}
              title="Group by project or worktree"
              onClick={() => setGroupByContext(!groupByContext)}
              className={cn(
                "toolbar-icon-button p-1 rounded-[var(--radius-sm)] border text-daintree-text/50",
                groupByContext ? "border-transparent" : "border-daintree-text/15"
              )}
            >
              <Layers className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="toolbar-icon-button inline-flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-[11px] text-daintree-text/50 whitespace-nowrap"
            >
              <CheckCheck className="w-3 h-3" aria-hidden="true" />
              Mark all read
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Pause notifications"
                title="Pause notifications"
                className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/50"
              >
                <Moon className="w-3 h-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => handleMuteFor(60 * 60 * 1000)}>
                For 1 hour
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleMuteUntilMorning}>{morningLabel}</DropdownMenuItem>
              <DropdownMenuItem onSelect={openNotificationSettings}>Custom…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                aria-label="Notification settings"
                onSelect={openNotificationSettings}
              >
                Notification settings…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {entries.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/50"
                  aria-label="More notification actions"
                  title="More notification actions"
                >
                  <Ellipsis className="w-3 h-3" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                <DropdownMenuItem
                  destructive
                  onSelect={() => {
                    clearAll();
                    onClose();
                  }}
                >
                  <Trash2 className="w-3 h-3 mr-2" aria-hidden="true" />
                  Clear all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {showMutedPill && (
        <div
          data-testid="notification-muted-pill"
          className="flex items-center gap-1.5 px-3 py-1 bg-overlay-subtle text-[11px] font-medium uppercase tracking-wide text-daintree-text/70"
        >
          <span className="truncate">{pillLabel}</span>
          {isSessionMuted && (
            <button
              type="button"
              onClick={handleResumeNotifications}
              aria-label="Resume notifications"
              title="Resume notifications"
              className="ml-0.5 inline-flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-daintree-text/70 hover:bg-overlay-emphasis hover:text-daintree-text transition-colors"
            >
              Resume
            </button>
          )}
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        <div
          ref={setScrollContainer}
          onKeyDown={handleListKeyDown}
          role={rowCount > 0 ? "list" : undefined}
          aria-label={rowCount > 0 ? "Notifications" : undefined}
          className="h-full overflow-y-auto"
        >
          {totalChronoGroups === 0 && needsAttentionGroups.length === 0 ? (
            filter === "archived" && entries.length > 0 ? (
              <EmptyState
                variant="user-cleared"
                scale="canvas"
                title="No archived notifications"
                icon={<Archive />}
                className="py-10"
              />
            ) : filter === "unread" && entries.length > 0 ? (
              // Canvas scale: the bell dropdown is a 360px panel-style surface that
              // mirrors GitHubResourceList ("connection-gated panel" example in
              // CLAUDE.md). The "Notifications appear here" guidance and the
              // "Adjust at Notification settings" inline link are intentional and
              // load-bearing — popover scale would forbid them at compile time.
              <EmptyState
                variant="user-cleared"
                scale="canvas"
                title="You're all caught up"
                icon={<Bell />}
                className="py-10"
              />
            ) : showMutedPill ? (
              <div data-testid="notification-muted-empty-state">
                <EmptyState
                  variant="zero-data"
                  scale="canvas"
                  title="Notifications paused"
                  icon={<Moon />}
                  description={mutedEmptyDescription}
                  className="py-10"
                />
              </div>
            ) : (
              <EmptyState
                variant="zero-data"
                scale="canvas"
                title="No notifications yet"
                icon={<Bell />}
                description={
                  <>
                    Notifications appear here. Adjust which ones at{" "}
                    <button
                      type="button"
                      onClick={openNotificationSettings}
                      className="underline text-daintree-text/70 hover:text-daintree-text transition-colors"
                    >
                      Notification settings
                    </button>
                    .
                  </>
                }
                className="py-10"
              />
            )
          ) : (
            <>
              {needsAttentionGroups.length > 0 && (
                <NeedsAttentionSection
                  groups={needsAttentionGroups}
                  indexOffset={0}
                  focusedIndex={focusedIndex}
                  setRowRef={setRowRef}
                  onRowFocus={setFocusedIndex}
                  onDropdownOpenChange={handleDropdownOpenChange}
                  onDismiss={dismissEntry}
                  onDismissThread={dismissByCorrelationId}
                />
              )}
              {chronoSections.map((section, sectionIdx) => (
                <ChronoSection
                  key={section.key}
                  section={section}
                  indexOffset={
                    needsAttentionGroups.length +
                    chronoSections.slice(0, sectionIdx).reduce((sum, s) => sum + s.groups.length, 0)
                  }
                  focusedIndex={focusedIndex}
                  setRowRef={setRowRef}
                  onRowFocus={setFocusedIndex}
                  onDropdownOpenChange={handleDropdownOpenChange}
                  groupByContext={groupByContext}
                  dividerGroupId={dividerGroupId}
                  dividerRef={setDividerEl}
                  lastClosedAt={lastClosedAt}
                  onDismiss={dismissEntry}
                  onDismissThread={dismissByCorrelationId}
                  onMarkIdsRead={markIdsReadWithUndo}
                />
              ))}
            </>
          )}
        </div>
        {dividerGroupId !== null && (
          <button
            type="button"
            data-testid="jump-to-new-pill"
            aria-label="Jump to new notifications"
            aria-hidden={!showJumpPill || undefined}
            tabIndex={showJumpPill ? 0 : -1}
            onClick={() => {
              dividerEl?.scrollIntoView({ block: "start", behavior: "instant" });
              dividerEl?.focus();
            }}
            className={cn(
              "absolute bottom-2 left-1/2 -translate-x-1/2 z-10",
              "inline-flex items-center gap-1.5 px-3 py-1 rounded-full",
              "bg-overlay-emphasis border border-tint/[0.08]",
              "shadow-[var(--theme-shadow-floating)]",
              "text-[11px] font-medium text-daintree-text/80",
              "hover:text-daintree-text hover:bg-overlay-emphasis",
              "transition-[transform,opacity] motion-reduce:transition-none",
              showJumpPill
                ? "opacity-100 translate-y-0 pointer-events-auto"
                : "opacity-0 translate-y-2 pointer-events-none"
            )}
            style={{
              transitionDuration: `${showJumpPill ? UI_ENTER_DURATION : UI_EXIT_DURATION}ms`,
              transitionTimingFunction: showJumpPill ? UI_ENTER_EASING : UI_EXIT_EASING,
            }}
          >
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            Jump to new
          </button>
        )}
      </div>
    </div>
  );
}

interface RovingSectionProps {
  indexOffset: number;
  focusedIndex: number;
  setRowRef: (index: number, el: HTMLDivElement | null) => void;
  onRowFocus: (index: number) => void;
  onDropdownOpenChange: (open: boolean) => void;
}

function NeedsAttentionSection({
  groups,
  indexOffset,
  focusedIndex,
  setRowRef,
  onRowFocus,
  onDropdownOpenChange,
  onDismiss,
  onDismissThread,
}: {
  groups: ThreadGroup[];
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
} & RovingSectionProps) {
  return (
    <div data-testid="needs-attention-section" className="border-b border-divider">
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-daintree-text/50">
        Needs attention
      </div>
      <div role="group" aria-label="Needs attention" className="divide-y divide-tint/[0.04]">
        {groups.map((group, idx) =>
          renderGroup(group, onDismiss, onDismissThread, {
            flatIndex: indexOffset + idx,
            focusedIndex,
            setRowRef,
            onRowFocus,
            onDropdownOpenChange,
          })
        )}
      </div>
    </div>
  );
}

function ChronoSection({
  section,
  groupByContext,
  dividerGroupId,
  dividerRef,
  lastClosedAt,
  indexOffset,
  focusedIndex,
  setRowRef,
  onRowFocus,
  onDropdownOpenChange,
  onDismiss,
  onDismissThread,
  onMarkIdsRead,
}: {
  section: ContextSection;
  groupByContext: boolean;
  dividerGroupId: string | null;
  dividerRef?: (el: HTMLDivElement | null) => void;
  lastClosedAt: number;
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
  onMarkIdsRead: (ids: string[], options: { resetLastClosed: boolean }) => void;
} & RovingSectionProps) {
  const sectionUnreadIds = section.groups.flatMap((g) =>
    g.entries.filter((e) => !e.seenAsToast).map((e) => e.id)
  );
  const newSinceUnreadIds = section.groups
    .filter((g) => g.latestTimestamp > lastClosedAt)
    .flatMap((g) => g.entries.filter((e) => !e.seenAsToast).map((e) => e.id));
  const sectionLabel = groupByContext ? "Notifications for this context" : "All notifications";
  return (
    <div data-testid="chrono-section">
      {groupByContext && (
        <ContextSectionHeader
          worktreeId={section.worktreeId}
          projectId={section.projectId}
          count={section.groups.length}
          unreadIds={sectionUnreadIds}
          onMarkRead={() => onMarkIdsRead(sectionUnreadIds, { resetLastClosed: false })}
        />
      )}
      <div role="group" aria-label={sectionLabel} className="divide-y divide-tint/[0.04]">
        {section.groups.map((group, idx) => {
          const groupKey = group.correlationId ?? group.entries[0]!.id;
          const isDivider = dividerGroupId !== null && groupKey === dividerGroupId;
          return (
            <div key={groupKey}>
              {isDivider && (
                <NewSinceLastLookedDivider
                  ref={dividerRef}
                  unreadCount={newSinceUnreadIds.length}
                  onMarkRead={() => onMarkIdsRead(newSinceUnreadIds, { resetLastClosed: true })}
                />
              )}
              {renderGroup(group, onDismiss, onDismissThread, {
                flatIndex: indexOffset + idx,
                focusedIndex,
                setRowRef,
                onRowFocus,
                onDropdownOpenChange,
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowRovingProps {
  flatIndex: number;
  focusedIndex: number;
  setRowRef: (index: number, el: HTMLDivElement | null) => void;
  onRowFocus: (index: number) => void;
  onDropdownOpenChange: (open: boolean) => void;
}

function renderGroup(
  group: ThreadGroup,
  onDismiss: (id: string) => void,
  onDismissThread: (correlationId: string) => void,
  roving: RowRovingProps
) {
  const isFocused = roving.flatIndex === roving.focusedIndex;
  const tabIndex = isFocused ? 0 : -1;
  const rowRef = (el: HTMLDivElement | null) => roving.setRowRef(roving.flatIndex, el);
  const handleFocus = () => roving.onRowFocus(roving.flatIndex);

  if (group.correlationId && group.entries.length > 1) {
    return (
      <NotificationThread
        key={group.correlationId}
        group={group}
        onDismiss={() => onDismissThread(group.correlationId!)}
        rowRef={rowRef}
        tabIndex={tabIndex}
        onRowFocus={handleFocus}
        onDropdownOpenChange={roving.onDropdownOpenChange}
      />
    );
  }
  const entry = group.entries[0]!;
  return (
    <NotificationCenterEntry
      key={entry.id}
      entry={entry}
      isNew={!entry.seenAsToast}
      onDismiss={() => onDismiss(entry.id)}
      rowRef={rowRef}
      tabIndex={tabIndex}
      role="listitem"
      onFocus={handleFocus}
      onDropdownOpenChange={roving.onDropdownOpenChange}
    />
  );
}

function ContextSectionHeader({
  worktreeId,
  projectId,
  count,
  unreadIds,
  onMarkRead,
}: {
  worktreeId?: string;
  projectId?: string;
  count: number;
  unreadIds: string[];
  onMarkRead: () => void;
}) {
  const worktreeName = useWorktreeStore((s) =>
    worktreeId ? s.worktrees.get(worktreeId)?.name : undefined
  );
  const label = worktreeName ?? worktreeId ?? projectId ?? "Other";
  const hasUnread = unreadIds.length > 0;
  return (
    <div
      data-testid="context-section-header"
      className="group/section flex items-center justify-between px-3 py-1 bg-overlay-subtle text-[10px] font-medium uppercase tracking-wide text-daintree-text/60"
    >
      <span className="truncate">{label}</span>
      <div className="ml-2 shrink-0 flex items-center gap-2">
        {hasUnread && (
          <button
            type="button"
            onClick={onMarkRead}
            className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-daintree-text/50 hover:text-daintree-text/80 hover:bg-overlay-emphasis focus-visible:text-daintree-text/80 focus-visible:bg-overlay-emphasis transition-colors"
          >
            Mark read
          </button>
        )}
        <span aria-hidden="true" className="text-daintree-text/40 tabular-nums">
          {count}
        </span>
      </div>
    </div>
  );
}

function NewSinceLastLookedDivider({
  ref,
  unreadCount,
  onMarkRead,
}: {
  ref?: (el: HTMLDivElement | null) => void;
  unreadCount: number;
  onMarkRead: () => void;
}) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-testid="new-since-last-looked"
      className="flex items-center gap-2 px-3 py-1 bg-overlay-subtle text-[10px] font-medium uppercase tracking-wide text-daintree-text/50 outline-hidden"
    >
      <span>New since you last looked</span>
      {unreadCount > 0 && (
        <button
          type="button"
          onClick={onMarkRead}
          className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-daintree-text/60 hover:bg-overlay-emphasis hover:text-daintree-text transition-colors"
        >
          {unreadCount === 1 ? "Mark this read" : `Mark these ${unreadCount} read`}
        </button>
      )}
    </div>
  );
}

function NotificationThread({
  group,
  onDismiss,
  rowRef,
  tabIndex,
  onRowFocus,
  onDropdownOpenChange,
}: {
  group: ThreadGroup;
  onDismiss: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  tabIndex?: number;
  onRowFocus?: () => void;
  onDropdownOpenChange?: (open: boolean) => void;
}) {
  const latest = group.entries[0];
  const isNew = group.entries.some((e) => !e.seenAsToast);

  if (!latest) return null;

  const displayType = getWorstSeverity(group.entries);

  // When the worst-severity icon disagrees with the latest entry's type (e.g.
  // an "error" thread whose newest entry is a "success" recovery), prefix the
  // preview text so the icon/message divergence reads as intentional rather
  // than a mismatch.
  const displayEntry =
    displayType !== latest.type && latest.message.length > 0
      ? { ...latest, message: `Latest: ${latest.message}` }
      : latest;

  return (
    <div
      ref={rowRef}
      tabIndex={tabIndex}
      role="listitem"
      onFocus={onRowFocus}
      data-testid="notification-thread"
      className={cn(
        "group relative border-l-2 border-tint/15",
        tabIndex !== undefined &&
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-daintree-accent/50"
      )}
    >
      <NotificationCenterEntry
        entry={displayEntry}
        displayType={displayType}
        threadCount={group.entries.length}
        isNew={isNew}
        onDismiss={onDismiss}
        onDropdownOpenChange={onDropdownOpenChange}
      />
    </div>
  );
}
