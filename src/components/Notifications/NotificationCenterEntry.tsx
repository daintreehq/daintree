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
  threadCount?: number;
  isNew?: boolean;
}

export function NotificationCenterEntry({
  entry,
  threadCount,
  isNew = false,
}: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[entry.type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 px-3 py-2 hover:bg-overlay-medium transition-colors border-l-2",
        isNew ? "border-canopy-accent bg-canopy-accent/[0.04]" : "border-transparent"
      )}
    >
      <div className={cn("mt-0.5 shrink-0", config.className)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        {entry.title && (
          <p className="text-xs font-medium text-canopy-text truncate">{entry.title}</p>
        )}
        <p className="text-xs text-canopy-text/70 leading-snug break-words">{entry.message}</p>
        {threadCount && threadCount > 1 && (
          <p className="text-[10px] text-canopy-text/40 mt-0.5">{threadCount} events</p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
        <span className="text-[10px] text-canopy-text/40 tabular-nums">
          {formatRelativeTime(entry.timestamp)}
        </span>
        {isNew && (
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-canopy-accent shrink-0" />
        )}
      </div>
    </div>
  );
}
