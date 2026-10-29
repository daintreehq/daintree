import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  Bell,
  CalendarClock,
  CheckCheck,
  Clock,
  Ellipsis,
  Moon,
  Trash2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useSnoozeExpiryTimer } from "./useSnoozeExpiryTimer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FLOATING_CARD_SURFACE_CLASS } from "@/components/ui/floatingSurface";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import {
  EVENT_KIND_TO_SETTING_KEY,
  muteForDuration,
  muteUntilNextMorning,
  setSessionQuietUntil,
  type NotificationEventKind,
} from "@/lib/notify";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isScheduledQuietNow, nextOccurrenceTimestamp } from "@shared/utils/quietHours";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import {
  computeEffectiveNotificationState,
  heroLine,
  osDndDisplayNote,
  selectKindOffKinds,
  KIND_SHORT_LABEL,
} from "@/lib/notificationEffectiveState";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { FilterChip } from "@/components/ui/FilterChip";
import { useWallClock } from "@/hooks/useWallClock";
import {
  buildFlatRows,
  deriveTriageView,
  filterTriageEntries,
  msUntilNeedsAttentionExpiry,
  type NotificationFilter,
} from "./notificationTriageModel";
import { useNotificationRowActions } from "./useNotificationRowActions";
import { useNotificationListKeyboard } from "./useNotificationListKeyboard";
import { ChronoSection, NeedsAttentionSection } from "./NotificationCenterSections";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Whether a kind ships switched on, so that it being off is the user's doing.
 * Outside the component: the compiler bails on a hook referenced as a value.
 */
function shipsOn(kind: NotificationEventKind): boolean {
  const key = EVENT_KIND_TO_SETTING_KEY[kind];
  return (
    key !== undefined && Reflect.get(useNotificationSettingsStore.getInitialState(), key) === true
  );
}

/** The per-project silences the row menu writes, with the words the strip uses. */
const PROJECT_SILENCEABLE = [
  ["completedEnabled", "Finished"],
  ["waitingEnabled", "Waiting"],
] as const;

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationCenter({ open, onClose }: NotificationCenterProps) {
  const entries = useNotificationHistoryStore((s) => s.entries);
  const unreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const snoozedThreads = useNotificationHistoryStore((s) => s.snoozedThreads);
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const dismissEntry = useNotificationHistoryStore((s) => s.dismissEntry);
  const dismissByCorrelationId = useNotificationHistoryStore((s) => s.dismissByCorrelationId);
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
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  const overridesByProjectId = useProjectSettingsStore((s) => s.notificationOverridesByProjectId);
  const projects = useProjectStore((s) => s.projects);
  const currentProjectOverrides = currentProjectId
    ? overridesByProjectId[currentProjectId]
    : undefined;
  // Every project the inbox has heard from, since a silence set from one of
  // their rows is as invisible as the current project's.
  const inboxProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) if (e.context?.projectId) ids.add(e.context.projectId);
    if (currentProjectId) ids.add(currentProjectId);
    return [...ids].sort();
  }, [entries, currentProjectId]);
  const inboxProjectKey = inboxProjectIds.join(",");
  // Re-read on every open. "Silence … from this project" writes straight to
  // the project's settings file and tells no renderer store, so this is the
  // point where the inbox can find out (and find out about an Undo).
  useEffect(() => {
    if (!open || inboxProjectKey === "") return;
    void useProjectSettingsStore
      .getState()
      .loadNotificationOverridesForProjects(inboxProjectKey.split(","));
  }, [open, inboxProjectKey]);

  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
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
      // No inset. It used to pull the bottom edge in by the fade's 32px, so a
      // divider sitting in that band counted as unreached — and the pill,
      // anchored to the same band, was drawn straight over the divider it
      // pointed at. A divider showing at all under the fade is found.
      { root: scrollContainer, threshold: 0 }
    );
    observer.observe(dividerEl);
    // An observer only reports crossings, and a jump from below the viewport
    // to above it (End, the scrollbar, a fast wheel) never crosses — it goes
    // from not-intersecting to not-intersecting, so the pill stayed up at the
    // bottom of the list pointing at something already passed. A scroll can
    // only ever retire it here; showing it stays the observer's job.
    const handleScroll = () => {
      const divider = dividerEl.getBoundingClientRect();
      const port = scrollContainer.getBoundingClientRect();
      if (divider.top <= port.bottom) setShowJumpPill(false);
    };
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [dividerEl]);

  useEffect(() => {
    if (showJumpPill && !prevShowJumpPillRef.current) {
      useAnnouncerStore.getState().announce("New notifications below", "polite");
    }
    prevShowJumpPillRef.current = showJumpPill;
  }, [showJumpPill]);

  const filteredEntries = useMemo(
    () => filterTriageEntries(entries, filter, frozenUnreadIds, snoozedThreads),
    [entries, filter, frozenUnreadIds, snoozedThreads]
  );

  // In state, not a render-time Date.now(): the compiler caches that with the
  // memo reading it, and an open inbox would keep pinning a thread that had
  // aged out. Re-read on new history and the moment a pinned thread ages out.
  // The delay stays stable across unrelated re-renders, each of which would
  // otherwise re-arm the wake-up from the old reading and push it back.
  const nextRailExpiry = useCallback(
    (at: number) => msUntilNeedsAttentionExpiry(entries, at),
    [entries]
  );
  const railNow = useWallClock(entries, nextRailExpiry);

  const { needsAttentionGroups, needsAttentionOverflow, chronoSections, dividerGroupId } = useMemo(
    () =>
      deriveTriageView({
        entries,
        filteredEntries,
        filter,
        groupByContext,
        lastClosedAt,
        snoozedThreads,
        now: railNow,
      }),
    [entries, filteredEntries, groupByContext, lastClosedAt, filter, snoozedThreads, railNow]
  );

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

  const {
    markIdsReadWithUndo,
    dispatchPrimaryAction,
    archiveRow,
    restoreRow,
    toggleReadForRow,
    handleSnoozeForRow,
    handleUnsnoozeForRow,
  } = useNotificationRowActions(entries);

  const flatRows = useMemo(
    () => buildFlatRows(needsAttentionGroups, chronoSections),
    [needsAttentionGroups, chronoSections]
  );
  const rowCount = flatRows.length;
  const {
    focusedIndex,
    setRowRef,
    handleRowFocus,
    handleDropdownOpenChange,
    moveFocusTo,
    handleListKeyDown,
    handleDialogKeyDown,
    snoozePendingIndex,
    consumeSnoozePending,
  } = useNotificationListKeyboard({
    open,
    filter,
    flatRows,
    dialogRef,
    archiveRow,
    toggleReadForRow,
    dispatchPrimaryAction,
  });

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
    // "Paused", the Pause menu's own word, and the end time on both kinds: the
    // strip is the one place that says when this stops, so the empty state
    // under it doesn't have to say it again.
    if (isSessionMuted) return `Paused until ${timeFormatter.format(new Date(quietUntil))}`;
    if (isScheduledMuted) {
      return `Quiet hours until ${timeFormatter.format(new Date(nextOccurrenceTimestamp(quietHoursEndMin)))}`;
    }
    // OS DND case — the in-app gates are off, so name the source plainly.
    return osDndDisplayNote(osDndActive) ?? "";
  })();
  // Effective-state summary: with the gates stacked, fold them into a single
  // line that answers "what will fire right now" plus which kinds are switched
  // off. Memoized over the gate inputs so it's a stable value the rest of the
  // render (and the compiler) can lean on.
  const { summaryHeroLine, offLabel, silencedLabel } = useMemo(() => {
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
    // A silence is a kind switched off that ships on. "Completed" ships off,
    // so counting every off kind would have put the strip on screen for
    // everyone who never touched a setting.
    const silenced = offKinds.filter(shipsOn);
    const label = (kinds: typeof offKinds) =>
      kinds.length > 0 ? `Off: ${kinds.map((k) => KIND_SHORT_LABEL[k]).join(", ")}` : "";
    return {
      summaryHeroLine: heroLine(states),
      offLabel: label(offKinds),
      silencedLabel: label(silenced),
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
  // Silences the user set that aren't a mute: kinds switched off app-wide, and
  // the ones this project has silenced (the row menu's "Silence…" and "Mute
  // project" write these). They used to surface only if a mute happened to
  // be on too, so a silenced inbox looked like a quiet one.
  const projectOffLabel = (() => {
    if (!currentProjectOverrides) return "";
    const off = PROJECT_SILENCEABLE.filter(([key]) => currentProjectOverrides[key] === false);
    if (off.length === 0) return "";
    if (off.length === PROJECT_SILENCEABLE.length) return "This project is muted";
    return `This project: ${off.map(([, label]) => label).join(", ")} off`;
  })();
  const otherProjectsOffLabel = (() => {
    const silenced = inboxProjectIds.filter(
      (id) =>
        id !== currentProjectId &&
        PROJECT_SILENCEABLE.some(([key]) => overridesByProjectId[id]?.[key] === false)
    );
    if (silenced.length === 0) return "";
    const names = silenced.map((id) => projects.find((p) => p.id === id)?.name);
    // Names while they fit; a count once they don't, or when one can't be named.
    if (silenced.length <= 2 && names.every(Boolean)) {
      return `Silenced in ${names.join(" and ")}`;
    }
    return `Silenced in ${silenced.length} other ${silenced.length === 1 ? "project" : "projects"}`;
  })();
  const hasSilences =
    silencedLabel !== "" || projectOffLabel !== "" || otherProjectsOffLabel !== "";
  const showQuietStrip = showMutedPill || hasSilences;
  const quietCause = pillLabel || (hasSilences ? "Some notifications are off" : summaryHeroLine);
  // OS Do Not Disturb silences the OS's banners, not Daintree's, so under it
  // alone the breakthrough list named every kind the app has — six or seven
  // names that all said "nothing changed in here". One clause says that.
  const osDndOnly = isOsDndActive && notificationsEnabled && !isSessionMuted && !isScheduledMuted;
  // A line per clause. Run together with " · " they broke wherever the width
  // fell, so "Off:" and the kind it named landed on different lines.
  // The lead names one cause; the others that are on at the same time get a
  // clause of their own, or Resume reads as the end of a quiet it doesn't end.
  const concurrentCauses = [
    isSessionMuted && isScheduledMuted
      ? `Quiet hours continue until ${timeFormatter.format(new Date(nextOccurrenceTimestamp(quietHoursEndMin)))}`
      : "",
    (isSessionMuted || isScheduledMuted) && isOsDndActive
      ? (osDndDisplayNote(osDndActive) ?? "")
      : "",
  ];
  const quietDetail = [
    ...concurrentCauses,
    pillLabel ? (osDndOnly ? "Daintree's own alerts still show" : summaryHeroLine) : "",
    pillLabel ? offLabel : silencedLabel,
    projectOffLabel,
    otherProjectsOffLabel,
  ].filter(Boolean);
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
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
              >
                <CheckCheck className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
                Mark all read
              </button>
            )}
            {/* Two icon controls, each named by a real tooltip. The native
                `title` they carried arrived late or not at all, so the moon read
                as a theme switch and nothing said otherwise. Group-by and
                settings live in the overflow menu with Clear all, which used to
                open onto that one item alone. */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Pause notifications"
                      className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                    >
                      <Moon className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Pause notifications</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuLabel>Pause notifications</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => handleMuteFor(60 * 60 * 1000)}>
                  <Clock data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  For 1 hour
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleMuteUntilMorning}>
                  <Clock data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  {morningLabel}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={openNotificationSettings}>
                  <CalendarClock data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Schedule quiet hours…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                      aria-label="More notification actions"
                    >
                      <Ellipsis className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {showGroupToggle && (
                  <>
                    <DropdownMenuCheckboxItem
                      checked={groupByContext}
                      onCheckedChange={(checked) => setGroupByContext(checked === true)}
                    >
                      Group by project or worktree
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  aria-label="Notification settings"
                  onSelect={openNotificationSettings}
                >
                  <Bell data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Notification settings…
                </DropdownMenuItem>
                {entries.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
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
                      <Trash2 data-menu-icon className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                      Clear all…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
              selected={filter === "all"}
              onClick={() => {
                setFilter("all");
                setFrozenUnreadIds(null);
              }}
            >
              All
            </FilterChip>
            <FilterChip selected={filter === "unread"} onClick={() => setFilter("unread")}>
              Unread
            </FilterChip>
            <FilterChip
              selected={filter === "archived"}
              onClick={() => {
                setFilter("archived");
                setFrozenUnreadIds(null);
              }}
            >
              Archived
            </FilterChip>
            {hasSnoozedThreads && (
              <FilterChip
                selected={filter === "snoozed"}
                onClick={() => {
                  setFilter("snoozed");
                  setFrozenUnreadIds(null);
                }}
              >
                Snoozed
              </FilterChip>
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
      {showQuietStrip && (
        <div
          data-testid="notification-muted-pill"
          className="flex shrink-0 items-start gap-2 pl-4 pr-3 py-1.5 bg-overlay-raised text-2xs text-text-secondary"
        >
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="font-medium text-text-primary">{quietCause}</span>
            {quietDetail.map((clause) => (
              <span key={clause} className="text-text-secondary">
                {clause}
              </span>
            ))}
          </div>
          {isSessionMuted && (
            <Button
              variant="subtle"
              size="xs"
              onClick={handleResumeNotifications}
              aria-label="Resume notifications"
              // Bordered, because without one this was bare text sitting at the
              // end of a line of bare text. It only read as a control under
              // `forced-colors: active`, where the UA supplies the border this
              // was missing — which is the tell that it was missing. Resume,
              // Manage and both mark-read actions share this one small-button
              // shape, so the panel has one.
              className="shrink-0 px-1.5 text-2xs focus-visible:-outline-offset-2"
            >
              Resume
            </Button>
          )}
          {/* Quiet hours too: they explained the silence and then left the way
              to change them two menus away. */}
          {!isSessionMuted && (hasSilences || isScheduledMuted) && (
            <Button
              variant="subtle"
              size="xs"
              onClick={openNotificationSettings}
              className="shrink-0 px-1.5 text-2xs focus-visible:-outline-offset-2"
            >
              Manage
            </Button>
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
                //
                // The popover scale and no description, like every other empty
                // state here: the strip above already says until when and holds
                // Resume, and at the canvas scale a 40px moon and an 18px title
                // repeated that strip at three times its size.
                <div data-testid="notification-muted-empty-state">
                  <EmptyState
                    variant="zero-data"
                    scale="popover"
                    title="Notifications paused"
                    icon={<Moon />}
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
                    onRowFocus={handleRowFocus}
                    onDropdownOpenChange={handleDropdownOpenChange}
                    onDismiss={dismissEntry}
                    onDismissThread={dismissByCorrelationId}
                    snoozePendingIndex={snoozePendingIndex}
                    snoozedThreads={snoozedThreads}
                    snoozeRenderTime={snoozeRenderTime}
                    onConsumeSnoozePending={consumeSnoozePending}
                    onSnoozeRow={handleSnoozeForRow}
                    onUnsnoozeRow={handleUnsnoozeForRow}
                    onArchiveRow={filter === "archived" ? undefined : archiveRow}
                    onToggleReadRow={filter === "archived" ? undefined : toggleReadForRow}
                    onRestoreRow={filter === "archived" ? restoreRow : undefined}
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
                    onRowFocus={handleRowFocus}
                    onDropdownOpenChange={handleDropdownOpenChange}
                    groupByContext={groupByContext}
                    hasPinnedAbove={needsAttentionGroups.length > 0}
                    dividerGroupId={dividerGroupId}
                    dividerRef={setDividerEl}
                    // No boundary in the tabs that aren't about arrival order.
                    lastClosedAt={filter === "archived" || filter === "snoozed" ? 0 : lastClosedAt}
                    onDismiss={dismissEntry}
                    onDismissThread={dismissByCorrelationId}
                    onMarkIdsRead={markIdsReadWithUndo}
                    snoozePendingIndex={snoozePendingIndex}
                    snoozedThreads={snoozedThreads}
                    snoozeRenderTime={snoozeRenderTime}
                    onConsumeSnoozePending={consumeSnoozePending}
                    onSnoozeRow={handleSnoozeForRow}
                    onUnsnoozeRow={handleUnsnoozeForRow}
                    onArchiveRow={filter === "archived" ? undefined : archiveRow}
                    onToggleReadRow={filter === "archived" ? undefined : toggleReadForRow}
                    onRestoreRow={filter === "archived" ? restoreRow : undefined}
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
              // Land on the first new ROW, not the divider: the list's keys
              // only move between rows, so focus parked on the label left
              // j/k/arrows doing nothing. The rail's copies come first in
              // flat order, so search past them.
              const pinned = needsAttentionGroups.length;
              const index = flatRows.findIndex(
                (row, i) => i >= pinned && row.key === dividerGroupId
              );
              if (index >= 0) moveFocusTo(index);
              else dividerEl?.focus();
            }}
            className={cn(
              "absolute bottom-2 left-1/2 -translate-x-1/2 z-10",
              "inline-flex items-center gap-1.5 px-3 py-1 rounded-full",
              // Opaque, like ScrollPill: it floats over notification rows, and
              // `overlay-raised` is ~4% alpha on dark themes, so the rows read
              // through it. The hover tint layers as an image over the fill.
              FLOATING_CARD_SURFACE_CLASS,
              "text-2xs font-medium text-text-secondary",
              "hover:text-text-primary hover:border-border-strong",
              "hover:bg-[linear-gradient(var(--color-overlay-hover),var(--color-overlay-hover))]",
              "transition-[translate,opacity] motion-reduce:transition-opacity motion-reduce:translate-y-0",
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
