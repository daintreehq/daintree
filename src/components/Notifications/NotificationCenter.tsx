import { useEffect } from "react";
import { Bell, Trash2 } from "lucide-react";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { NotificationCenterEntry } from "./NotificationCenterEntry";

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationCenter({ open, onClose }: NotificationCenterProps) {
  const entries = useNotificationHistoryStore((s) => s.entries);
  const clearAll = useNotificationHistoryStore((s) => s.clearAll);
  const markAllRead = useNotificationHistoryStore((s) => s.markAllRead);

  useEffect(() => {
    if (open) {
      markAllRead();
    }
  }, [open, markAllRead]);

  useEffect(() => {
    if (open && entries.length > 0) {
      markAllRead();
    }
  }, [open, entries, markAllRead]);

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
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-canopy-text/30">
            <Bell className="h-6 w-6 mb-2" />
            <span className="text-xs">No notifications yet</span>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {entries.map((entry) => (
              <NotificationCenterEntry key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
