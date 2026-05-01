import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle, MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import type { NotificationType } from "@/store/notificationStore";
import { DURATION_250 } from "@/lib/animationUtils";
import {
  formatNotificationCountAriaLabel,
  formatNotificationCountGlyph,
} from "./notificationCount";
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
  displayType?: NotificationType;
  threadCount?: number;
  isNew?: boolean;
  onDismiss?: () => void;
}

export function NotificationCenterEntry({
  entry,
  displayType,
  threadCount,
  isNew = false,
  onDismiss,
}: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[displayType ?? entry.type];
  const Icon = config.icon;

  const showChip =
    typeof threadCount === "number" && Number.isFinite(threadCount) && threadCount > 1;
  // Leading-edge throttle: bump the chip's React `key` to remount the span and
  // restart the CSS animation, but suppress re-fires within DURATION_250 so
  // chatty agent-state churn (#6427) doesn't strobe the chip. The displayed
  // count still updates immediately — only the animation trigger is gated.
  const safeCount = threadCount ?? 0;
  const lastCountRef = useRef(safeCount);
  const lastBumpTimeRef = useRef(0);
  const [bumpKey, setBumpKey] = useState(0);
  useEffect(() => {
    if (safeCount <= lastCountRef.current) {
      lastCountRef.current = safeCount;
      return;
    }
    lastCountRef.current = safeCount;
    const now = Date.now();
    if (now - lastBumpTimeRef.current < DURATION_250) return;
    lastBumpTimeRef.current = now;
    setBumpKey((k) => k + 1);
  }, [safeCount]);

  return (
    <div className="group flex items-start gap-2.5 px-3 py-2 hover:bg-overlay-medium transition-colors">
      <div className={cn("mt-0.5 shrink-0", config.className)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        {entry.title && (
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-medium text-daintree-text truncate">{entry.title}</p>
            {showChip && (
              <span
                key={bumpKey}
                aria-label={formatNotificationCountAriaLabel(safeCount)}
                style={{ animationDuration: "150ms" }}
                className={cn(
                  "shrink-0 rounded-full bg-tint/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
                  bumpKey > 0 && "animate-badge-bump"
                )}
              >
                {formatNotificationCountGlyph(safeCount)}
              </span>
            )}
          </div>
        )}
        <p className="text-xs text-daintree-text/70 leading-snug break-words">{entry.message}</p>
        {showChip && !entry.title && (
          <span
            key={bumpKey}
            aria-label={formatNotificationCountAriaLabel(safeCount)}
            style={{ animationDuration: "150ms" }}
            className={cn(
              "mt-0.5 inline-block rounded-full bg-tint/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
              bumpKey > 0 && "animate-badge-bump"
            )}
          >
            {formatNotificationCountGlyph(safeCount)}
          </span>
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
                        : "border border-status-info/30 bg-status-info/15 text-status-info hover:bg-status-info/20"
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
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-info shrink-0" />
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
