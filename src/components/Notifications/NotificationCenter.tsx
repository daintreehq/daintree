import { useEffect, useMemo, useState } from "react";
import { Bell, Trash2 } from "lucide-react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";

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
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const markAllRead = useNotificationHistoryStore((s) => s.markAllRead);

  const [unseenIds, setUnseenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      const currentEntries = useNotificationHistoryStore.getState().entries;
      setUnseenIds(new Set(currentEntries.filter((e) => !e.seenAsToast).map((e) => e.id)));
      markAllRead();
    } else {
      setUnseenIds(new Set());
    }
  }, [open, markAllRead]);

  useEffect(() => {
    if (open && entries.some((e) => !e.seenAsToast)) {
      markAllRead();
    }
  }, [open, entries, markAllRead]);

  const groups = useMemo(() => groupByCorrelationId(entries), [entries]);

  return (
    <div className="w-[360px] max-h-[420px] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <span className="text-xs font-medium text-canopy-text/80">Notifications</span>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={() => {
              clearAll();
              onClose();
            }}
            className="flex items-center gap-1 text-[10px] text-canopy-text/50 hover:text-canopy-text/80 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            Clear all
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-canopy-text/30">
            <Bell className="h-6 w-6 mb-2" />
            <span className="text-xs">No notifications yet</span>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {groups.map((group) =>
              group.correlationId && group.entries.length > 1 ? (
                <NotificationThread key={group.correlationId} group={group} unseenIds={unseenIds} />
              ) : (
                <NotificationCenterEntry
                  key={group.entries[0].id}
                  entry={group.entries[0]}
                  isNew={unseenIds.has(group.entries[0].id)}
                />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationThread({ group, unseenIds }: { group: ThreadGroup; unseenIds: Set<string> }) {
  const latest = group.entries[0];
  const isNew = group.entries.some((e) => unseenIds.has(e.id));

  return (
    <div className="relative">
      <NotificationCenterEntry entry={latest} threadCount={group.entries.length} isNew={isNew} />
    </div>
  );
}
