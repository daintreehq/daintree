import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCheck, Moon, Settings2, Trash2 } from "lucide-react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { muteForDuration, muteUntilNextMorning, notify } from "@/lib/notify";
import type { NotificationType } from "@/store/notificationStore";

const SEVERITY_WEIGHTS: Record<NotificationType, number> = {
  error: 3,
  warning: 2,
  info: 1,
  success: 0,
} as const;

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

  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [frozenUnreadIds, setFrozenUnreadIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!open) {
      setFrozenUnreadIds(null);
    }
  }, [open]);

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
      message: `Notifications muted ${label}`,
      priority: "low",
      urgent: true,
    });
  };

  const handleMuteUntilMorning = () => {
    const until = muteUntilNextMorning();
    const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    notify({
      type: "info",
      message: `Notifications muted until ${formatter.format(new Date(until))}`,
      priority: "low",
      urgent: true,
    });
  };

  return (
    <div className="w-[360px] max-h-[420px] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-daintree-text/80">Notifications</span>
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
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => handleMuteFor(60 * 60 * 1000, "for 1h")}
            className="text-daintree-text/50"
            title="Suppress non-urgent notifications for the next hour"
          >
            <Moon />
            Mute 1h
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleMuteUntilMorning}
            className="text-daintree-text/50"
            title="Suppress non-urgent notifications until 8:00 AM"
          >
            Until morning
          </Button>
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
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onClose();
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "notifications" },
                { source: "user" }
              );
            }}
            className="text-daintree-text/50"
          >
            <Settings2 />
            Configure
          </Button>
          {entries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                clearAll();
                onClose();
              }}
              className="text-daintree-text/50"
            >
              <Trash2 />
              Clear all
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-daintree-text/30">
            <Bell className="h-6 w-6 mb-2" />
            <span className="text-xs">
              {filter === "unread" && entries.length > 0
                ? "You're all caught up"
                : "No notifications yet"}
            </span>
          </div>
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
