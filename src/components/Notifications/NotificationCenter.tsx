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
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { useSnoozeExpiryTimer } from "./useSnoozeExpiryTimer";
import { resolveSnoozeDuration, type SnoozeDurationOption } from "@shared/utils/snoozeTimestamps";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
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
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const [snoozePendingIndex, setSnoozePendingIndex] = useState<number | null>(null);
  const [frozenUnreadIds, setFrozenUnreadIds] = useState<Set<string> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
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
    const scrollContainer = scrollContainerRef.current;
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
      // Pull the bottom edge in by the height of the scroll fade (h-8 in
      // ScrollShadow): a divider still under the gradient is washed out, so it
      // doesn't count as reached and the pill stays up.
      { root: scrollContainer, rootMargin: "0px 0px -32px 0px", threshold: 0 }
    );
    observer.observe(dividerEl);
    return () => observer.disconnect();
  }, [dividerEl]);

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

  // Take focus into the panel when it opens. The bell keeps `aria-haspopup` and
  // the panel is portalled to the end of `document.body`, so without this the
  // next Tab walks the whole rest of the app instead of entering the surface
  // the user just asked for — the rows are reachable in principle and not in
  // practice. Deliberately the ROOT and not the first row: focusing a row on
  // open is a separate, settled decision (see the row-count effect above) and
  // this leaves it alone.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus({ preventScroll: true });
  }, [open]);

  // The first arrow press hands off from the panel root into the list. The
  // list's own handler bails unless `document.activeElement` is already a row,
  // so without this bridge a keyboard user who has just opened the panel
  // presses Down and nothing happens.
  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (dropdownOpenCountRef.current > 0) return;
      if (rowCount === 0) return;
      switch (e.key) {
        case "j":
        case "ArrowDown":
        case "Home":
          e.preventDefault();
          moveFocusTo(0);
          return;
        case "k":
        case "ArrowUp":
        case "End":
          e.preventDefault();
          moveFocusTo(rowCount - 1);
          return;
        default:
          return;
      }
    },
    [rowCount, moveFocusTo]
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
  // The strip leads with why it is quiet and follows with what still gets
  // through. `pillLabel` is empty only when nothing in-app is muted and the OS
  // signal is unknown — in that case the breakthrough line is the only thing
  // there is to say, so it becomes the lead rather than leaving a blank one.
  const quietCause = pillLabel || summaryHeroLine;
  const quietDetail = [pillLabel ? summaryHeroLine : "", offLabel].filter(Boolean).join(" · ");
  // What "Clear all" actually costs, named in the confirm. The count is the
  // preview; the archived and snoozed breakdown is the part a user standing on
  // the Archived tab would not otherwise expect, since the store call ignores
  // the active filter entirely.
  const clearAllConsequence = useMemo(() => {
    const total = entries.length;
    const archived = entries.filter((e) => e.archivedAt !== null).length;
    const now = Date.now();
    const snoozed = Object.values(snoozedThreads).filter(
      (v) => typeof v === "number" && v > now
    ).length;
    const extras: string[] = [];
    if (archived > 0) extras.push(`${archived} archived`);
    if (snoozed > 0) extras.push(`${snoozed} snoozed ${snoozed === 1 ? "thread" : "threads"}`);
    const noun = total === 1 ? "notification" : "notifications";
    const tail = extras.length > 0 ? `, including ${extras.join(" and ")}` : "";
    return `Removes all ${total} ${noun}${tail}. This clears every tab, not just the one you're looking at.`;
  }, [entries, snoozedThreads]);
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
    <div
      ref={dialogRef}
      data-testid="notification-center"
      // The bell advertises `aria-haspopup="dialog"`, so the thing it opens has
      // to actually be one, with a name — otherwise assistive tech is promised
      // an interaction contract that never arrives. Non-modal on purpose: no
      // `aria-modal`, no focus trap, and the rest of the app stays reachable.
      // Matches CopyTreeRecentsPanel, the other FixedDropdown panel.
      role="dialog"
      aria-label="Notifications"
      // Focused on open, and it has to be: the panel is portalled to the end of
      // `document.body` while the bell sits in the toolbar, so leaving focus on
      // the bell means the next Tab walks the rest of the application instead
      // of entering the surface that just opened. The rows are then reachable
      // only in principle. -1 so it takes programmatic focus without joining
      // the tab ring, and no trap: Tab still leaves.
      //
      // This is NOT the "focus the first row on open" behaviour the code below
      // deliberately avoids — the row set is untouched, and a pointer user sees
      // no ring, because `:focus-visible` only matches when the last input was
      // a key.
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      // Width stays 360px — the row grid is tuned for it and it reads well.
      // Height was the problem: a flat 420px meant the same small box on a 27"
      // display as on a laptop, with a third of the window sitting empty below
      // it while the list was cut off. Now it scales with the viewport, stops
      // at 720px so it never becomes an absurd ribbon on a tall monitor, and
      // never exceeds the room actually left under the bell — which also fixes
      // the opposite failure, a short window where a fixed 420px would run off
      // the bottom of the screen. `--fixed-dropdown-available-height` comes
      // from FixedDropdown's own positioning pass; the 420px fallback keeps
      // the old behaviour if this ever renders outside that shell.
      //
      // The focus ring uses a negative offset because the panel is full-bleed
      // inside FixedDropdown's `overflow-hidden` shell, which clips an outset
      // one — the same reason the rows do it.
      className={cn(
        "w-[360px] max-h-[min(72vh,720px,var(--fixed-dropdown-available-height,420px))] flex flex-col",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      )}
    >
      {/* Two rows, not one. Sharing a line with the toolbar squeezed the filter
          group down to about 120px, so all four chips wrapped onto three lines
          and the header ate a quarter of a 420px popover while roughly 230px
          sat empty to the right of them. It also stranded "All" up beside the
          heading, where it read as part of the title rather than as a peer of
          the other three.

          The right edge stays tighter than the left on purpose: the icon
          buttons carry their own internal touch padding, so a smaller container
          inset lands their glyphs at roughly the same optical distance from the
          edge as the title text on the 16px left margin. */}
      {/* `shrink-0`: the list wrapper below carries `flex-1`, so its scaled
          shrink factor is 0 and negative free space lands entirely on the
          chrome. With the new `availableHeight` floor a short window can reach
          that, and the header would be clipped instead of the list. */}
      <div className="flex flex-col shrink-0 border-b border-divider">
        <div className="flex items-center justify-between pl-4 pr-2.5 py-2 gap-2">
          {/* Full strength, semibold. At /80 the panel's own heading measured
              dimmer than the row titles underneath it — the label naming the
              surface was quieter than the content it named, which is the
              hierarchy upside down. */}
          <span className="min-w-0 truncate text-xs font-semibold text-text-primary">
            Notifications
          </span>
          {/* gap-1.5, not gap-1: four controls at 4px apart, one of them a text
              button, read as a single crowded clump jammed into the corner. */}
          <div className="flex items-center gap-1.5 shrink-0">
            {showGroupToggle && (
              <button
                type="button"
                aria-label="Group by project or worktree"
                aria-pressed={groupByContext}
                title="Group by project or worktree"
                onClick={() => setGroupByContext(!groupByContext)}
                className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/70"
              >
                <Layers className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="toolbar-icon-button inline-flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-2xs text-daintree-text/70 whitespace-nowrap"
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
                  className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/70"
                >
                  <Moon className="w-3 h-3" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onSelect={() => handleMuteFor(60 * 60 * 1000)}>
                  For 1 hour
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleMuteUntilMorning}>
                  {morningLabel}
                </DropdownMenuItem>
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
                    className="toolbar-icon-button p-1 rounded-[var(--radius-sm)] text-daintree-text/70"
                    aria-label="More notification actions"
                    title="More notification actions"
                  >
                    <Ellipsis className="w-3 h-3" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  <DropdownMenuItem
                    destructive
                    // Confirm first. `clearAll` empties the whole store —
                    // active, archived AND snoozed — regardless of which tab
                    // you are looking at, and the emptied state is persisted,
                    // so a mis-click on the Archived tab silently destroys the
                    // record of a whole fleet run with no undo. That is a D1
                    // local-irreversible action under
                    // docs/architecture/destructive-action-safeguards.md, which
                    // requires a ConfirmDialog and a verb-noun button; the
                    // in-repo precedent is `logs.clear`.
                    onSelect={() => setClearAllConfirmOpen(true)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                    Clear all
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {entries.length > 0 && (
          // The chip row sits on the same 16px margin as every other band. An
          // earlier pass inset it by the chip's own padding so the LABELS
          // landed on the text column, but that put the selected pill 4px off
          // the panel edge, into the same crowded strip as the unread dots and
          // the thread rail. Between aligning label-to-label and keeping one
          // clean left margin, the margin wins: a pill is a surface, and
          // surfaces line up with surfaces.
          <div className="flex flex-wrap items-center gap-1.5 pl-4 pr-2 pb-2">
            <FilterChip
              label="All"
              selected={filter === "all"}
              onSelect={() => {
                setFilter("all");
                setFrozenUnreadIds(null);
              }}
            />
            <FilterChip
              label="Unread"
              selected={filter === "unread"}
              onSelect={() => setFilter("unread")}
            />
            <FilterChip
              label="Archived"
              selected={filter === "archived"}
              onSelect={() => {
                setFilter("archived");
                setFrozenUnreadIds(null);
              }}
            />
            {hasSnoozedThreads && (
              <FilterChip
                label="Snoozed"
                selected={filter === "snoozed"}
                onSelect={() => {
                  setFilter("snoozed");
                  setFrozenUnreadIds(null);
                }}
              />
            )}
          </div>
        )}
      </div>
      {/* The quiet-state strip. Three things changed here.
          Order: it used to lead with "Will interrupt you: …" and demote "Muted
          until 10:56 PM" underneath. But the question this strip exists to
          answer is why the panel is quiet, and the exception is the footnote,
          not the headline — so the cause leads and the breakthrough list
          follows.
          Truncation: both lines were `truncate`. The strings that overflow are
          exactly the ones that matter — OS DND, or several kinds switched off —
          so the failure mode was that the more there was to say, the less got
          said, silently. They wrap now; this strip is at most two lines of
          11px text either way.
          Height: one flex row instead of a column with a nested row, and the
          detail line only renders when there is a detail. On the common
          "muted until X, nothing else unusual" case that is a single line. */}
      {showMutedPill && (
        <div
          data-testid="notification-muted-pill"
          className="flex shrink-0 items-start gap-2 pl-4 pr-3 py-1.5 bg-overlay-raised text-2xs text-daintree-text/70"
        >
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="font-medium text-text-primary">{quietCause}</span>
            {quietDetail && <span className="text-daintree-text/70">{quietDetail}</span>}
          </div>
          {isSessionMuted && (
            <button
              type="button"
              onClick={handleResumeNotifications}
              aria-label="Resume notifications"
              title="Resume notifications"
              // A border, because without one this was bare text sitting at the
              // end of a line of bare text. It only read as a control under
              // `forced-colors: active`, where the UA supplies the border this
              // was missing — which is the tell that it was missing. Matches the
              // secondary row action, so the panel has one button shape.
              className="inline-flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-daintree-text/20 px-1.5 py-0.5 text-2xs font-medium text-daintree-text/70 hover:bg-overlay-medium hover:text-text-primary transition-colors"
            >
              Resume
            </button>
          )}
        </div>
      )}
      {/* `flex flex-col` here is load-bearing, not tidying. This slot is a flex
          ITEM of the panel, so its own height comes out of flex layout and its
          CSS `height` stays `auto` — and a percentage height resolves against
          the *specified* height of its containing block, not the used one. So
          the `h-full` this used to hand ScrollShadow silently computed to
          `auto`, the scrollport took its full 1546px content height, and the
          dropdown shell simply clipped it at the panel's 420px. Nothing
          scrolled: no scrollbar, no wheel, no keyboard, and no bottom fade
          either, because `canScrollDown` compares scrollHeight to clientHeight
          and they were equal. Making this a flex container and sizing the child
          with `flex-1 min-h-0` keeps the bound in flex space, where it
          resolves. Same shape as CopyTreeRecentsPanel, the other FixedDropdown
          panel. Covered by `assertScrollportIsBounded` in
          e2e/screenshots/notification-center-review.spec.ts (#12061). */}
      <div className="relative flex flex-col flex-1 min-h-0">
        <ScrollShadow
          ref={scrollContainerRef}
          onKeyDown={handleListKeyDown}
          role={rowCount > 0 ? "list" : undefined}
          aria-label={rowCount > 0 ? "Notifications" : undefined}
          className="flex-1 min-h-0"
          // The fades occlude the first and last 32px of the scrollport, so keep
          // scroll-into-view targets (the jump-to-new divider, keyboard-focused
          // rows) clear of them.
          scrollClassName="scroll-py-8"
        >
          {/* One stable child: the shadow hook observes firstElementChild, so it
              must outlive the empty-state/section swaps below. */}
          <div>
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
        </ScrollShadow>
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
              "text-2xs font-medium text-daintree-text/80",
              "hover:text-text-primary hover:bg-overlay-raised",
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
      <ConfirmDialog
        isOpen={clearAllConfirmOpen}
        onClose={() => setClearAllConfirmOpen(false)}
        variant="destructive"
        title="Clear all notifications?"
        // The specific consequence, not generic irreversibility copy: the count
        // is the preview, and naming archived and snoozed is the part a user on
        // the Archived tab would otherwise not expect.
        description={clearAllConsequence}
        confirmLabel="Clear notifications"
        onConfirm={() => {
          clearAll();
          setClearAllConfirmOpen(false);
          onClose();
        }}
      />
    </div>
  );
}

/**
 * One filter segment. Four copies of the same twelve-class string is three
 * chances to let them drift, and the forced-colors handle below has to be on
 * every one of them or the mode it exists for is the mode it misses.
 *
 * No accent in either state, deliberately: membership in a segmented control is
 * exactly the "multi-element, non-load-bearing" case the accent rule excludes,
 * and the accent here is spent on focus.
 */
function FilterChip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      // Handle for the `forced-colors: active` block in index.css. There the UA
      // flattens `bg-filter-selected-bg-strong` to Canvas and paints every chip
      // as the same outlined pill, so which filter you are looking at becomes
      // unreadable — the same failure the destructive-button rule in that block
      // already solves, and solved the same way: a heavier border.
      data-notification-filter="true"
      onClick={onSelect}
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-2xs rounded-full transition-colors",
        selected
          ? "bg-filter-selected-bg-strong text-text-primary font-medium"
          : "text-daintree-text/60 hover:text-text-primary hover:bg-tint/[0.04]"
      )}
    >
      {label}
    </button>
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
      <div className="pl-4 pr-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wide text-daintree-text/70">
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
          className="pl-4 pr-3 pb-2 text-3xs text-text-secondary"
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
              // This used to carry `content-visibility: auto` with
              // `contain-intrinsic-size: auto 72px`. Rows here measure 44px to
              // 123.5px, so the 72px placeholder was wrong by up to 71% for
              // every row not yet scrolled into view: scrollHeight was a
              // fiction, the thumb jumped as rows rendered for the first time,
              // and the content below moved while you were scrolling toward it
              // — during the one interaction this panel exists for. The skip
              // was never worth that; the history is capped at 200 entries
              // (MAX_ENTRIES, notificationHistorySlice) which group into fewer
              // rows still, and that is a modest list for a plain container.
              // If this ever profiles badly, the answer is measured virtualization
              // (Virtuoso, as used elsewhere in the app), not a single guessed
              // height standing in for rows that differ by a factor of three.
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
      className="group/section flex items-center justify-between pl-4 pr-3 py-1 bg-overlay-raised text-3xs font-medium uppercase tracking-wide text-daintree-text/60"
    >
      <span className="truncate">{label}</span>
      <div className="ml-2 shrink-0 flex items-center gap-2">
        {hasUnread && (
          <button
            type="button"
            onClick={onMarkRead}
            className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-text-secondary hover:text-text-primary hover:bg-overlay-raised focus-visible:text-text-primary focus-visible:bg-overlay-raised transition-colors"
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
      className="flex items-center gap-2 pl-4 pr-3 py-1 bg-overlay-raised text-3xs font-medium uppercase tracking-wide text-daintree-text/70 outline-hidden"
    >
      <span>New since you last looked</span>
      {unreadCount > 0 && (
        <button
          type="button"
          onClick={onMarkRead}
          className="inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 normal-case tracking-normal text-daintree-text/60 hover:bg-overlay-raised hover:text-text-primary transition-colors"
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
        "group relative",
        // Same treatment as a solo row (NotificationCenterEntry). Both are
        // stops on the same roving-tabindex ring, so they must not focus
        // differently — one outline, one box-shadow ring would read as two
        // kinds of row.
        tabIndex !== undefined && PALETTE_ROW_FOCUS_CLASS
      )}
    >
      {/* The thread rail, out of flow on purpose. As a `border-l-2` it was part
          of the box, so every threaded row's icon, unread dot and title sat 2px
          right of every solo row's — the panel's left column visibly broke on
          exactly the rows that carry the most weight. Absolute positioning
          keeps the mark and drops the displacement.
          `data-notification-thread-rail` is not styling: a background is forced
          to Canvas under `forced-colors: active` and would vanish, where the old
          border survived, so index.css repaints it the same way it repaints the
          unread dot and the count chip. */}
      <span
        aria-hidden="true"
        data-notification-thread-rail="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-tint/15"
      />
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
