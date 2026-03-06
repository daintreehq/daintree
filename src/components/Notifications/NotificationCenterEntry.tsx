import { CheckCircle2, XCircle, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, className: "text-status-success" },
  error: { icon: XCircle, className: "text-status-error" },
  info: { icon: Info, className: "text-status-info" },
  warning: { icon: AlertTriangle, className: "text-status-warning" },
};

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface NotificationCenterEntryProps {
  entry: NotificationHistoryEntry;
}

export function NotificationCenterEntry({ entry }: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[entry.type];
  const Icon = config.icon;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2 hover:bg-overlay-medium transition-colors">
      <div className={cn("mt-0.5 shrink-0", config.className)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        {entry.title && (
          <p className="text-xs font-medium text-canopy-text truncate">{entry.title}</p>
        )}
        <p className="text-xs text-canopy-text/70 leading-snug break-words">{entry.message}</p>
      </div>
      <span className="shrink-0 text-[10px] text-canopy-text/40 tabular-nums mt-0.5">
        {formatRelativeTime(entry.timestamp)}
      </span>
    </div>
  );
}
