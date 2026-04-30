import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCheck, Ellipsis, Moon, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";
import { muteForDuration, muteUntilNextMorning, notify, setSessionQuietUntil } from "@/lib/notify";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { isScheduledQuietNow, nextOccurrenceTimestamp } from "@shared/utils/quietHours";
import type { NotificationType } from "@/store/notificationStore";

const SEVERITY_WEIGHTS: Record<NotificationType, number> = {
  error: 3,
  warning: 2,
  info: 1,
  success: 0,
} as const;

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

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

interface ThreadGroup {
  correlationId: string | undefined;
  entries: NotificationHistoryEntry[];
  latestTimestamp: number;
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

export function NotificationCenter({ open, onClose }: NotificationCenterProps) {
  const entries = useNotificationHistoryStore((s) => s.entries);
  const unreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const markAllRead = useNotificationHistoryStore((s) => s.markAllRead);
  const dismissEntry = useNotificationHistoryStore((s) => s.dismissEntry);

  const {
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
  } = useNotificationSettingsStore(
    useShallow((s) => ({
      quietUntil: s.quietUntil,
      quietHoursEnabled: s.quietHoursEnabled,
      quietHoursStartMin: s.quietHoursStartMin,
      quietHoursEndMin: s.quietHoursEndMin,
      quietHoursWeekdays: s.quietHoursWeekdays,
    }))
  );

  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [frozenUnreadIds, setFrozenUnreadIds] = useState<Set<string> | null>(null);

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

  const filteredEntries = useMemo(() => {
    if (filter === "all") return entries;
    if (frozenUnreadIds) {
      return entries.filter((e) => !e.seenAsToast || frozenUnreadIds.has(e.id));
    }
    return entries.filter((e) => !e.seenAsToast);
  }, [entries, filter, frozenUnreadIds]);

  const groups = useMemo(() => groupByCorrelationId(filteredEntries), [filteredEntries]);

  const handleMarkAllRead = () => {
    if (filter === "unread") {
      setFrozenUnreadIds(new Set(entries.filter((e) => !e.seenAsToast).map((e) => e.id)));
    }
    markAllRead();
  };

  const handleMuteFor = (durationMs: number, label: string) => {
    muteForDuration(durationMs);
    notify({
      type: "info",
      title: "Notifications muted",
      message: `Notifications muted ${label}`,
      priority: "high",
      duration: 3000,
      urgent: true,
    });
  };

  const handleMuteUntilMorning = () => {
    const until = muteUntilNextMorning();
    notify({
      type: "info",
      title: "Notifications muted",
      message: `Notifications muted until ${timeFormatter.format(new Date(until))}`,
      priority: "high",
      duration: 3000,
      urgent: true,
    });
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

  return (
    <div className="w-[360px] max-h-[420px] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {showMutedPill ? (
            <span
              data-testid="notification-muted-pill"
              className="inline-flex items-center gap-1 rounded-full bg-overlay-medium px-2 py-0.5 text-[11px] text-daintree-text/70"
            >
              <span className="font-medium text-daintree-text/80">Notifications</span>
              <span aria-hidden="true" className="text-daintree-text/40">
                ·
              </span>
              <span className="truncate">{pillLabel}</span>
              {isSessionMuted && (
                <button
                  type="button"
                  onClick={handleResumeNotifications}
                  aria-label="Resume notifications"
                  title="Resume notifications"
                  className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 text-daintree-text/50 hover:bg-overlay-emphasis hover:text-daintree-text/80 transition-colors"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ) : (
            <span className="text-xs font-medium text-daintree-text/80">Notifications</span>
          )}
          {entries.length > 0 && (
            <div className="flex items-center rounded-md border border-daintree-text/10 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setFilter("all");
                  setFrozenUnreadIds(null);
                }}
                className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  filter === "all"
                    ? "bg-overlay-medium text-daintree-text/80"
                    : "text-daintree-text/40 hover:text-daintree-text/60"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setFilter("unread")}
                className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  filter === "unread"
                    ? "bg-overlay-medium text-daintree-text/80"
                    : "text-daintree-text/40 hover:text-daintree-text/60"
                }`}
              >
                Unread
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleMarkAllRead}
              className="text-daintree-text/50"
            >
              <CheckCheck />
              Mark all read
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Pause notifications"
                title="Pause notifications"
                className="p-1 hover:bg-daintree-text/10 text-daintree-text/50 hover:text-daintree-text/80 transition-colors rounded-[var(--radius-sm)]"
              >
                <Moon className="w-3 h-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => handleMuteFor(60 * 60 * 1000, "for 1 hour")}>
                For 1 hour
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleMuteUntilMorning}>{morningLabel}</DropdownMenuItem>
              <DropdownMenuItem onSelect={openNotificationSettings}>Custom…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                aria-label="Notification settings"
                onSelect={openNotificationSettings}
              >
                Notification settings{" "}
                <span aria-hidden="true" className="ml-auto pl-2 text-daintree-text/40">
                  →
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {entries.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="p-1 hover:bg-daintree-text/10 text-daintree-text/50 hover:text-daintree-text/80 transition-colors rounded-[var(--radius-sm)]"
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
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          filter === "unread" && entries.length > 0 ? (
            <EmptyState
              variant="user-cleared"
              title="You're all caught up"
              icon={<Bell />}
              className="py-10"
            />
          ) : (
            <EmptyState
              variant="zero-data"
              title="No notifications yet"
              icon={<Bell />}
              className="py-10"
            />
          )
        ) : (
          <div className="divide-y divide-tint/[0.04]">
            {groups.map((group) =>
              group.correlationId && group.entries.length > 1 ? (
                <NotificationThread
                  key={group.correlationId}
                  group={group}
                  onDismiss={dismissEntry}
                />
              ) : (
                <NotificationCenterEntry
                  key={group.entries[0]!.id}
                  entry={group.entries[0]!}
                  isNew={!group.entries[0]!.seenAsToast}
                  onDismiss={() => dismissEntry(group.entries[0]!.id)}
                />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationThread({
  group,
  onDismiss,
}: {
  group: ThreadGroup;
  onDismiss: (id: string) => void;
}) {
  const latest = group.entries[0];
  const isNew = group.entries.some((e) => !e.seenAsToast);

  if (!latest) return null;

  const displayType = getWorstSeverity(group.entries);

  return (
    <div className="relative">
      <NotificationCenterEntry
        entry={latest}
        displayType={displayType}
        threadCount={group.entries.length}
        isNew={isNew}
        onDismiss={() => onDismiss(latest.id)}
      />
    </div>
  );
}
