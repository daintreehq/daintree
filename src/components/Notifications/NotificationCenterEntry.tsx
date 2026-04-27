import { CheckCircle2, XCircle, Info, AlertTriangle, MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  onDismiss?: () => void;
}

export function NotificationCenterEntry({
  entry,
  threadCount,
  isNew = false,
  onDismiss,
}: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[entry.type];
  const Icon = config.icon;

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 hover:bg-overlay-medium transition-colors">
      <div className={cn("mt-0.5 shrink-0", config.className)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        {entry.title && (
          <p className="text-xs font-medium text-daintree-text truncate">{entry.title}</p>
        )}
        <p className="text-xs text-daintree-text/70 leading-snug break-words">{entry.message}</p>
        {threadCount && threadCount > 1 && (
          <p className="text-[10px] tabular-nums text-daintree-text/40 mt-0.5">
            {threadCount} events
          </p>
        )}
        {entry.actions && entry.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {entry.actions.map((action, index) => {
              const manifest = actionService.get(action.actionId as ActionId);
              const isAvailable = manifest !== null && manifest.enabled;
              return (
                <button
                  key={`${action.actionId}-${index}`}
                  type="button"
                  aria-disabled={!isAvailable || undefined}
                  title={
                    !isAvailable ? (manifest?.disabledReason ?? "Action unavailable") : undefined
                  }
                  onClick={
                    isAvailable
                      ? () =>
                          void actionService.dispatch(
                            action.actionId as ActionId,
                            action.actionArgs
                          )
                      : undefined
                  }
                  className={cn(
                    "h-6 rounded-[var(--radius-sm)] px-2 text-[11px] font-medium transition-colors",
                    isAvailable
                      ? action.variant === "secondary"
                        ? "border border-daintree-text/20 text-daintree-text/70 hover:bg-overlay-medium"
                        : "border border-daintree-accent/40 bg-daintree-accent/15 text-daintree-accent hover:bg-daintree-accent/25"
                      : "border border-daintree-text/10 text-daintree-text/30 cursor-not-allowed"
                  )}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
        <span className="text-[10px] text-daintree-text/40 tabular-nums">
          {formatRelativeTime(entry.timestamp)}
        </span>
        {isNew && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-daintree-accent shrink-0"
          />
        )}
        {entry.context?.projectId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Notification options"
                onClick={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 h-4 w-4 flex items-center justify-center rounded text-daintree-text/40 hover:text-daintree-text/70 transition-opacity"
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem
                onSelect={() => {
                  const projectId = entry.context?.projectId;
                  if (!projectId) return;
                  void actionService.dispatch("project.muteNotifications", { projectId });
                }}
              >
                Mute project notifications
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 h-4 w-4 flex items-center justify-center rounded text-daintree-text/40 hover:text-daintree-text/70 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
