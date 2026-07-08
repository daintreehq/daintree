import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  Bell,
  CheckCheck,
  Clock,
  Ellipsis,
  Layers,
  Moon,
  Trash2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { useSnoozeExpiryTimer } from "./useSnoozeExpiryTimer";
import { resolveSnoozeDuration, type SnoozeDurationOption } from "@shared/utils/snoozeTimestamps";
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
import { getWorstSeverity, SEVERITY_WEIGHTS } from "@/lib/notificationSeverity";
import {
  computeEffectiveNotificationState,
  heroLine,
  osDndDisplayNote,
  selectKindOffKinds,
  KIND_SHORT_LABEL,
} from "@/lib/notificationEffectiveState";

const NEEDS_ATTENTION_CAP = 5;
const CONTEXT_NONE_KEY = "__none__";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

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
  const snoozedThreads = useNotificationHistoryStore((s) => s.snoozedThreads);
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const markIdsRead = useNotificationHistoryStore((s) => s.markIdsRead);
  const markUnseenAsToast = useNotificationHistoryStore((s) => s.markUnseenAsToast);
  const dismissEntry = useNotificationHistoryStore((s) => s.dismissEntry);
  const dismissByCorrelationId = useNotificationHistoryStore((s) => s.dismissByCorrelationId);
  const archiveEntry = useNotificationHistoryStore((s) => s.archiveEntry);
  const archiveByCorrelationId = useNotificationHistoryStore((s) => s.archiveByCorrelationId);
  const snoozeThread = useNotificationHistoryStore((s) => s.snoozeThread);
  const clearSnooze = useNotificationHistoryStore((s) => s.clearSnooze);
  const clearExpiredSnoozes = useNotificationHistoryStore((s) => s.clearExpiredSnoozes);

  useSnoozeExpiryTimer(snoozedThreads, clearExpiredSnoozes);

  const {
    notificationsEnabled,
    completedEnabled,
    waitingEnabled,
    workingPulseEnabled,
    uiFeedbackSoundEnabled,
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
    groupByContext,
    setGroupByContext,
    osDndActive,
  } = useNotificationSettingsStore(
    useShallow((s) => ({
      notificationsEnabled: s.enabled,
      completedEnabled: s.completedEnabled,
      waitingEnabled: s.waitingEnabled,
      workingPulseEnabled: s.workingPulseEnabled,
      uiFeedbackSoundEnabled: s.uiFeedbackSoundEnabled,
      quietUntil: s.quietUntil,
      quietHoursEnabled: s.quietHoursEnabled,
      quietHoursStartMin: s.quietHoursStartMin,
      quietHoursEndMin: s.quietHoursEndMin,
      quietHoursWeekdays: s.quietHoursWeekdays,
      groupByContext: s.groupByContext,
      setGroupByContext: s.setGroupByContext,
      osDndActive: s.osDndActive,
    }))
  );

  const lastClosedAt = useUIStore((s) => s.lastNotificationCenterClosedAt);
  const resetLastClosedAt = useUIStore((s) => s.resetNotificationCenterLastClosedAt);

  const [filter, setFilter] = useState<"all" | "unread" | "archived" | "snoozed">("all");
  const [snoozePendingIndex, setSnoozePendingIndex] = useState<number | null>(null);
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
  // Quantized to the minute so every row doesn't get a fresh prop on each
  // unrelated re-render — snooze expiry only needs minute resolution, and the
  // quiet-hours tick already re-renders on minute boundaries.
  const snoozeRenderTime = now - (now % 60_000);
  const isSessionMuted = quietUntil > now;
  const isScheduledMuted = isScheduledQuietNow({
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
  });
  const isOsDndActive = osDndActive === true;
  // The OS DND pill is informational only — it surfaces a state the user
  // chose at the OS level. In-app toasts still fire (the OS already silences
  // its native banners), but the working-pulse audio is gated in main.
  const showMutedPill = isSessionMuted || isScheduledMuted || isOsDndActive;

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

    const clearAll = () => {
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
      timeouts.length = 0;
      intervals.length = 0;
    };

    // Visibility may flip between scheduling and firing; bail out if hidden.
    const tickIfVisible = () => {
      if (document.hidden) return;
      tick();
    };

    const schedule = () => {
      if (isSessionMuted) {
        const delay = Math.max(0, quietUntil - Date.now());
        timeouts.push(setTimeout(tickIfVisible, delay + 50));
      }

      if (quietHoursEnabled) {
        const msToNextMinute = 60_000 - (Date.now() % 60_000);
        timeouts.push(
          setTimeout(() => {
            if (document.hidden) return;
            tick();
            intervals.push(setInterval(tickIfVisible, 60_000));
          }, msToNextMinute + 50)
        );
      }
    };

    const handleVisibility = () => {
      clearAll();
      if (!document.hidden) {
        tick();
        schedule();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) {
      schedule();
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      clearAll();
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
    // Recompute "is snoozed?" per entry against the current snooze map.
    // Inlining the check keeps callers from threading `now` everywhere — for
    // the inbox-render path a single timestamp captured per render is fine
    // (the expiry timer will re-render when a snooze actually expires).
    const now = Date.now();
    const isSnoozed = (e: NotificationHistoryEntry): boolean => {
      if (!e.correlationId) return false;
      const until = snoozedThreads[e.correlationId];
      return typeof until === "number" && until > now;
    };
    if (filter === "snoozed") {
      // Snoozed tab shows only actively-snoozed (non-archived) entries.
      // Archived entries that happen to belong to a still-snoozed
      // correlationId stay in Archived, not here — Snoozed is the "deferred
      // commitment" surface, Archived is the "done" surface.
      return entries.filter((e) => e.archivedAt === null && isSnoozed(e));
    }
    if (filter === "archived") {
      return entries.filter((e) => e.archivedAt !== null);
    }
    if (filter === "all") {
      // Archived entries belong to the Archived tab only — they're done.
      // Snoozed threads are intentionally hidden until they un-snooze.
      return entries.filter((e) => e.archivedAt === null && !isSnoozed(e));
    }
    if (frozenUnreadIds) {
      return entries.filter(
        (e) =>
          e.archivedAt === null && !isSnoozed(e) && (!e.seenAsToast || frozenUnreadIds.has(e.id))
      );
    }
    return entries.filter((e) => e.archivedAt === null && !e.seenAsToast && !isSnoozed(e));
  }, [entries, filter, frozenUnreadIds, snoozedThreads]);

  const { needsAttentionGroups, needsAttentionOverflow, chronoSections, dividerGroupId } =
    useMemo(() => {
      const now = Date.now();
      const isSnoozedGroup = (g: ThreadGroup): boolean => {
        if (!g.correlationId) return false;
        const until = snoozedThreads[g.correlationId];
        return typeof until === "number" && until > now;
      };
      // Pinned reflects the global unread severe-threads set so it stays the
      // same in All and Unread filter views. Hidden in Archived and Snoozed —
      // pinned is for active, attention-required items only. Snoozed threads
      // are an explicit defer so they must drop out of the pinned rail.
      const severeUnread =
        filter === "archived" || filter === "snoozed"
          ? []
          : groupByCorrelationId(entries.filter((e) => e.archivedAt === null))
              .filter((g) => {
                if (isSnoozedGroup(g)) return false;
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
              });
      const pinned = severeUnread.slice(0, NEEDS_ATTENTION_CAP);

      const chronoGroups = groupByCorrelationId(filteredEntries);
      const sections: ContextSection[] = groupByContext
        ? partitionByContext(chronoGroups)
        : [{ key: "all", groups: chronoGroups }];

      let divider: string | null = null;
      if (lastClosedAt > 0 && filter !== "archived" && filter !== "snoozed") {
        for (const g of chronoGroups) {
          if (g.latestTimestamp > lastClosedAt) {
            divider = g.correlationId ?? g.entries[0]?.id ?? null;
            break;
          }
        }
      }

      return {
        needsAttentionGroups: pinned,
        needsAttentionOverflow: severeUnread.length - pinned.length,
        chronoSections: sections,
        dividerGroupId: divider,
      };
    }, [entries, filteredEntries, groupByContext, lastClosedAt, filter, snoozedThreads]);

  const totalChronoGroups = chronoSections.reduce((sum, s) => sum + s.groups.length, 0);

  // Prefix sums for each section's starting row index — computed in one pass
  // instead of re-summing all prior sections per section during render.
  const chronoSectionOffsets: number[] = [];
  {
    let offset = 0;
    for (const s of chronoSections) {
      chronoSectionOffsets.push(offset);
      offset += s.groups.length;
    }
  }

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
    // eslint-disable-next-line no-restricted-syntax -- transient confirmations omit context
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

  // Build a fast index of unread entry IDs grouped by row, so the `u` toggle
  // can flip read/unread for the focused row in one store call. Without this
  // memo each keystroke would walk every entry looking for matches.
  const flatRowEntryIds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of groupByCorrelationId(entries)) {
      const key = group.correlationId ?? group.entries[0]!.id;
      map.set(
        key,
        group.entries.filter((e) => !e.archivedAt).map((e) => e.id)
      );
    }
    return map;
  }, [entries]);

  const toggleReadForRow = useCallback(
    (row: FlatRow) => {
      const ids = flatRowEntryIds.get(row.key) ?? [row.entryId];
      const live = useNotificationHistoryStore.getState().entries;
      const liveById = new Map(live.map((e) => [e.id, e] as const));
      const unreadIds = ids.filter((id) => {
        const e = liveById.get(id);
        return e !== undefined && !e.seenAsToast;
      });
      if (unreadIds.length > 0) {
        markIdsRead(unreadIds);
      } else {
        // Whole row already read — flip the head entry back to unread so the
        // dot reappears. Skip when the head entry no longer exists (a
        // dismissal or prune raced the keystroke).
        const head = liveById.get(row.entryId);
        if (head && head.seenAsToast && !head.archivedAt) {
          markUnseenAsToast(row.entryId, { silent: true });
        }
      }
    },
    [flatRowEntryIds, markIdsRead, markUnseenAsToast]
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
        case "u": {
          // Linear-parity toggle: flip the focused row between read and
          // unread. Lowercase only — uppercase `U` is reserved for a future
          // bulk action and would conflict with Shift-modified navigation.
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          const row = flatRows[activeIndex];
          if (!row) return;
          toggleReadForRow(row);
          return;
        }
        case "h": {
          // Linear-parity snooze: open the snooze sub-menu on the focused
          // row. Lowercase only and only for correlated rows (snooze is a
          // thread-level concept). The dropdown-open guard at the top of
          // this handler keeps subsequent j/k from double-navigating.
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          const row = flatRows[activeIndex];
          if (!row || !row.correlationId) return;
          e.preventDefault();
          setSnoozePendingIndex(activeIndex);
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
    [
      rowCount,
      flatRows,
      moveFocusTo,
      dismissEntry,
      archiveRow,
      dispatchPrimaryAction,
      filter,
      toggleReadForRow,
    ]
  );

  const handleSnoozeForRow = useCallback(
    (row: FlatRow, option: SnoozeDurationOption) => {
      if (!row.correlationId) return;
      snoozeThread(row.correlationId, resolveSnoozeDuration(option));
    },
    [snoozeThread]
  );

  const handleUnsnoozeForRow = useCallback(
    (row: FlatRow) => {
      if (!row.correlationId) return;
      clearSnooze(row.correlationId);
    },
    [clearSnooze]
  );

  const consumeSnoozePending = useCallback(() => setSnoozePendingIndex(null), []);

  const handleMarkAllRead = () => {
    // Archived entries are already done; they must never appear in the
    // mark-all-read undo set or the "Marked N as read" count. Snoozed
    // threads are explicit deferrals — silently marking them read would
    // override the user's choice and the resurfaced row would have no
    // unread dot when its snooze expires.
    const now = Date.now();
    const ids = entries
      .filter((e) => {
        if (e.seenAsToast || e.archivedAt) return false;
        if (e.correlationId && snoozedThreads[e.correlationId] !== undefined) {
          const until = snoozedThreads[e.correlationId];
          if (typeof until === "number" && until > now) return false;
        }
        return true;
      })
      .map((e) => e.id);
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

  const pillLabel = (() => {
    if (isSessionMuted) return `Muted until ${timeFormatter.format(new Date(quietUntil))}`;
    if (isScheduledMuted) return "Quiet hours";
    // OS DND case — the in-app gates are off, so name the source plainly.
    return osDndDisplayNote(osDndActive) ?? "";
  })();
  // Effective-state summary: with the gates stacked, fold them into a single
  // line that answers "what will fire right now" plus which kinds are switched
  // off. Memoized over the gate inputs so it's a stable value the rest of the
  // render (and the compiler) can lean on.
  const { summaryHeroLine, offLabel } = useMemo(() => {
    // `isQuiet` only encodes in-app suppression (session mute + scheduled
    // quiet) — OS DND must never be folded into `isQuiet` because it would
    // flip kinds to `quiet-gated`, which the hard constraint forbids.
    const inAppQuiet = isSessionMuted || isScheduledMuted;
    const states = computeEffectiveNotificationState({
      enabled: notificationsEnabled,
      isQuiet: inAppQuiet,
      completedEnabled,
      waitingEnabled,
      workingPulseEnabled,
      uiFeedbackSoundEnabled,
      osDndActive,
    });
    const offKinds = selectKindOffKinds(states);
    return {
      summaryHeroLine: heroLine(states),
      offLabel:
        offKinds.length > 0 ? `Off: ${offKinds.map((k) => KIND_SHORT_LABEL[k]).join(", ")}` : "",
    };
  }, [
    notificationsEnabled,
    isSessionMuted,
    isScheduledMuted,
    completedEnabled,
    waitingEnabled,
    workingPulseEnabled,
    uiFeedbackSoundEnabled,
    osDndActive,
  ]);
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
  // Hide the Snoozed tab when nothing is snoozed — it would otherwise be a
  // dead chip that always opens to an empty state, training users to ignore
  // it. Snap focus back to "all" if the active snooze just expired while the
  // tab was open so the user isn't stranded on a vanished tab.
  const hasSnoozedThreads = useMemo(() => {
    const now = Date.now();
    for (const value of Object.values(snoozedThreads)) {
      if (typeof value === "number" && value > now) return true;
    }
    return false;
  }, [snoozedThreads]);
  useEffect(() => {
    if (filter === "snoozed" && !hasSnoozedThreads) {
      setFilter("all");
    }
  }, [filter, hasSnoozedThreads]);

  return (
    <div className="w-[360px] max-h-[420px] flex flex-col">
      {/* pr-2, not px-3: the right-side icon buttons carry 4px of internal p-1
          touch padding, so an 8px container edge lands their glyphs at the same
          12px optical inset as the title text on the left. */}
      <div className="flex items-start justify-between pl-3 pr-2 py-2 border-b border-divider gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
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
              {hasSnoozedThreads && (
                <button
                  type="button"
                  aria-pressed={filter === "snoozed"}
                  onClick={() => {
                    setFilter("snoozed");
                    setFrozenUnreadIds(null);
                  }}
                  className={cn(
                    "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full transition-colors",
                    filter === "snoozed"
                      ? "bg-filter-selected-bg-strong text-daintree-text font-medium"
                      : "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.04]"
                  )}
                >
                  Snoozed
                </button>
              )}
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
              className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/50"
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
                  <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
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
          className="flex flex-col gap-0.5 px-3 py-1.5 bg-overlay-raised text-[11px] text-daintree-text/70"
        >
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium">{summaryHeroLine}</span>
            {isSessionMuted && (
              <button
                type="button"
                onClick={handleResumeNotifications}
                aria-label="Resume notifications"
                title="Resume notifications"
                className="inline-flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] font-medium text-daintree-text/70 hover:bg-overlay-raised hover:text-daintree-text transition-colors"
              >
                Resume
              </button>
            )}
          </div>
          <span className="truncate text-daintree-text/50">
            {pillLabel}
            {offLabel && <span> · {offLabel}</span>}
          </span>
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
            filter === "snoozed" && entries.length > 0 ? (
              <EmptyState
                variant="user-cleared"
                scale="sidebar"
                title="Nothing snoozed"
                icon={<Clock />}
                className="py-10"
              />
            ) : filter === "archived" && entries.length > 0 ? (
              <EmptyState
                variant="user-cleared"
                scale="sidebar"
                title="No archived notifications"
                icon={<Archive />}
                className="py-10"
              />
            ) : filter === "unread" && entries.length > 0 ? (
              <EmptyState
                variant="user-cleared"
                scale="sidebar"
                title="You're all caught up"
                icon={<Bell />}
                className="py-10"
              />
            ) : isSessionMuted || isScheduledMuted ? (
              // OS DND alone does not trigger the "Notifications paused" copy
              // — in-app toasts still fire, so naming them "paused" would be
              // misleading. The pill above still surfaces the OS state.
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
                scale="popover"
                title="No notifications yet"
                icon={<Bell />}
                className="py-10"
              />
            )
          ) : (
            <>
              {needsAttentionGroups.length > 0 && (
                <NeedsAttentionSection
                  groups={needsAttentionGroups}
                  overflowCount={needsAttentionOverflow}
                  indexOffset={0}
                  focusedIndex={focusedIndex}
                  setRowRef={setRowRef}
                  onRowFocus={setFocusedIndex}
                  onDropdownOpenChange={handleDropdownOpenChange}
                  onDismiss={dismissEntry}
                  onDismissThread={dismissByCorrelationId}
                  snoozePendingIndex={snoozePendingIndex}
                  snoozedThreads={snoozedThreads}
                  snoozeRenderTime={snoozeRenderTime}
                  onConsumeSnoozePending={consumeSnoozePending}
                  onSnoozeRow={handleSnoozeForRow}
                  onUnsnoozeRow={handleUnsnoozeForRow}
                />
              )}
              {chronoSections.map((section, sectionIdx) => (
                <ChronoSection
                  key={section.key}
                  section={section}
                  indexOffset={
                    needsAttentionGroups.length + (chronoSectionOffsets[sectionIdx] ?? 0)
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
                  snoozePendingIndex={snoozePendingIndex}
                  snoozedThreads={snoozedThreads}
                  snoozeRenderTime={snoozeRenderTime}
                  onConsumeSnoozePending={consumeSnoozePending}
                  onSnoozeRow={handleSnoozeForRow}
                  onUnsnoozeRow={handleUnsnoozeForRow}
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
              "bg-overlay-raised border border-border-strong",
              "shadow-[var(--theme-shadow-floating)]",
              "text-[11px] font-medium text-daintree-text/80",
              "hover:text-daintree-text hover:bg-overlay-raised",
              "transition-[translate,opacity] motion-reduce:transition-none",
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
  overflowCount,
  indexOffset,
  focusedIndex,
  setRowRef,
  onRowFocus,
  onDropdownOpenChange,
  onDismiss,
  onDismissThread,
  snoozePendingIndex,
  snoozedThreads,
  snoozeRenderTime,
  onConsumeSnoozePending,
  onSnoozeRow,
  onUnsnoozeRow,
}: {
  groups: ThreadGroup[];
  /** Severe unread threads beyond the pinned cap — they remain in the chronological list below. */
  overflowCount: number;
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
  snoozePendingIndex: number | null;
  snoozedThreads: Record<string, number>;
  snoozeRenderTime: number;
  onConsumeSnoozePending: () => void;
  onSnoozeRow: (row: FlatRow, option: SnoozeDurationOption) => void;
  onUnsnoozeRow: (row: FlatRow) => void;
} & RovingSectionProps) {
  return (
    <div data-testid="needs-attention-section" className="border-b border-divider">
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-daintree-text/50">
        Needs attention
      </div>
      <div role="group" aria-label="Needs attention">
        {groups.map((group, idx) => {
          const flatIndex = indexOffset + idx;
          return renderGroup(
            group,
            onDismiss,
            onDismissThread,
            {
              flatIndex,
              focusedIndex,
              setRowRef,
              onRowFocus,
              onDropdownOpenChange,
            },
            buildSnoozeProps(
              group,
              flatIndex,
              snoozePendingIndex,
              snoozedThreads,
              snoozeRenderTime,
              {
                onConsumeSnoozePending,
                onSnooze: onSnoozeRow,
                onUnsnooze: onUnsnoozeRow,
              }
            )
          );
        })}
      </div>
      {overflowCount > 0 && (
        <div
          data-testid="needs-attention-overflow"
          className="px-3 pb-2 text-[10px] text-daintree-text/45"
        >
          +{overflowCount} more below
        </div>
      )}
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
  snoozePendingIndex,
  snoozedThreads,
  snoozeRenderTime,
  onConsumeSnoozePending,
  onSnoozeRow,
  onUnsnoozeRow,
}: {
  section: ContextSection;
  groupByContext: boolean;
  dividerGroupId: string | null;
  dividerRef?: (el: HTMLDivElement | null) => void;
  lastClosedAt: number;
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
  onMarkIdsRead: (ids: string[], options: { resetLastClosed: boolean }) => void;
  snoozePendingIndex: number | null;
  snoozedThreads: Record<string, number>;
  snoozeRenderTime: number;
  onConsumeSnoozePending: () => void;
  onSnoozeRow: (row: FlatRow, option: SnoozeDurationOption) => void;
  onUnsnoozeRow: (row: FlatRow) => void;
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
      <div role="group" aria-label={sectionLabel}>
        {section.groups.map((group, idx) => {
          const groupKey = group.correlationId ?? group.entries[0]!.id;
          const isDivider = dividerGroupId !== null && groupKey === dividerGroupId;
          const flatIndex = indexOffset + idx;
          return (
            <div
              key={groupKey}
              // Off-screen rows skip layout/paint — the popover mounts up to
              // 200 heavy rows in a plain scroll container (sidebar precedent).
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 72px" }}
            >
              {isDivider && (
                <NewSinceLastLookedDivider
                  ref={dividerRef}
                  unreadCount={newSinceUnreadIds.length}
                  onMarkRead={() => onMarkIdsRead(newSinceUnreadIds, { resetLastClosed: true })}
                />
              )}
              {renderGroup(
                group,
                onDismiss,
                onDismissThread,
                {
                  flatIndex,
                  focusedIndex,
                  setRowRef,
                  onRowFocus,
                  onDropdownOpenChange,
                },
                buildSnoozeProps(
                  group,
                  flatIndex,
                  snoozePendingIndex,
                  snoozedThreads,
                  snoozeRenderTime,
                  {
                    onConsumeSnoozePending,
                    onSnooze: onSnoozeRow,
                    onUnsnooze: onUnsnoozeRow,
                  }
                )
              )}
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

interface SnoozeRowProps {
  isSnoozePending: boolean;
  isSnoozed: boolean;
  snoozedUntil: number | undefined;
  onConsumeSnoozePending: () => void;
  onSnooze: (option: SnoozeDurationOption) => void;
  onUnsnooze: () => void;
}

function renderGroup(
  group: ThreadGroup,
  onDismiss: (id: string) => void,
  onDismissThread: (correlationId: string) => void,
  roving: RowRovingProps,
  snooze: SnoozeRowProps
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
        isSnoozePending={snooze.isSnoozePending}
        isSnoozed={snooze.isSnoozed}
        snoozedUntil={snooze.snoozedUntil}
        onConsumeSnoozePending={snooze.onConsumeSnoozePending}
        onSnooze={snooze.onSnooze}
        onUnsnooze={snooze.onUnsnooze}
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
      isSnoozePending={snooze.isSnoozePending}
      isSnoozed={snooze.isSnoozed}
      snoozedUntil={snooze.snoozedUntil}
      onConsumeSnoozePending={snooze.onConsumeSnoozePending}
      onSnooze={snooze.onSnooze}
      onUnsnooze={snooze.onUnsnooze}
    />
  );
}

function buildSnoozeProps(
  group: ThreadGroup,
  flatIndex: number,
  snoozePendingIndex: number | null,
  snoozedThreads: Record<string, number>,
  now: number,
  handlers: {
    onConsumeSnoozePending: () => void;
    onSnooze: (row: FlatRow, option: SnoozeDurationOption) => void;
    onUnsnooze: (row: FlatRow) => void;
  }
): SnoozeRowProps {
  const row = buildFlatRow(group);
  const snoozedUntil = group.correlationId ? snoozedThreads[group.correlationId] : undefined;
  const isSnoozed =
    typeof snoozedUntil === "number" && Number.isFinite(snoozedUntil) && snoozedUntil > now;
  return {
    isSnoozePending: snoozePendingIndex === flatIndex && !!group.correlationId,
    isSnoozed,
    snoozedUntil: isSnoozed ? snoozedUntil : undefined,
    onConsumeSnoozePending: handlers.onConsumeSnoozePending,
    onSnooze: (option) => handlers.onSnooze(row, option),
    onUnsnooze: () => handlers.onUnsnooze(row),
  };
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
      className="group/section flex items-center justify-between px-3 py-1 bg-overlay-raised text-[10px] font-medium uppercase tracking-wide text-daintree-text/60"
    >
      <span className="truncate">{label}</span>
      <div className="ml-2 shrink-0 flex items-center gap-2">
        {hasUnread && (
          <button
            type="button"
            onClick={onMarkRead}
            className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-daintree-text/50 hover:text-daintree-text/80 hover:bg-overlay-raised focus-visible:text-daintree-text/80 focus-visible:bg-overlay-raised transition-colors"
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
      className="flex items-center gap-2 px-3 py-1 bg-overlay-raised text-[10px] font-medium uppercase tracking-wide text-daintree-text/50 outline-hidden"
    >
      <span>New since you last looked</span>
      {unreadCount > 0 && (
        <button
          type="button"
          onClick={onMarkRead}
          className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-daintree-text/60 hover:bg-overlay-raised hover:text-daintree-text transition-colors"
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
  isSnoozePending,
  isSnoozed,
  snoozedUntil,
  onConsumeSnoozePending,
  onSnooze,
  onUnsnooze,
}: {
  group: ThreadGroup;
  onDismiss: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  tabIndex?: number;
  onRowFocus?: () => void;
  onDropdownOpenChange?: (open: boolean) => void;
  isSnoozePending?: boolean;
  isSnoozed?: boolean;
  snoozedUntil?: number;
  onConsumeSnoozePending?: () => void;
  onSnooze?: (option: SnoozeDurationOption) => void;
  onUnsnooze?: () => void;
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
        isSnoozePending={isSnoozePending}
        isSnoozed={isSnoozed}
        snoozedUntil={snoozedUntil}
        onConsumeSnoozePending={onConsumeSnoozePending}
        onSnooze={onSnooze}
        onUnsnooze={onUnsnooze}
      />
    </div>
  );
}
