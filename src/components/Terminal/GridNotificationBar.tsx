import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";

const STATUS_CONFIG = {
  success: {
    icon: CheckCircle2,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-success)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-success)_14%,transparent),color-mix(in_oklab,var(--color-status-success)_6%,transparent))]",
    iconClass: "text-status-success",
    titleClass: "text-status-success",
  },
  error: {
    icon: XCircle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-error)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-error)_14%,transparent),color-mix(in_oklab,var(--color-status-error)_6%,transparent))]",
    iconClass: "text-status-error",
    titleClass: "text-status-error",
  },
  info: {
    icon: Info,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-info)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-info)_14%,transparent),color-mix(in_oklab,var(--color-status-info)_6%,transparent))]",
    iconClass: "text-status-info",
    titleClass: "text-status-info",
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-warning)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-warning)_14%,transparent),color-mix(in_oklab,var(--color-status-warning)_6%,transparent))]",
    iconClass: "text-status-warning",
    titleClass: "text-status-warning",
  },
} satisfies Record<
  Notification["type"],
  {
    icon: React.ComponentType<{ className?: string }>;
    containerClass: string;
    iconClass: string;
    titleClass: string;
  }
>;

function getActions(notification: Notification) {
  if (notification.actions && notification.actions.length > 0) {
    return notification.actions;
  }
  return notification.action ? [notification.action] : [];
}

export interface GridNotificationBarProps {
  className?: string;
}

export function GridNotificationBar({ className }: GridNotificationBarProps) {
  const notification = useNotificationStore(
    useShallow((state) => state.notifications.find((item) => item.placement === "grid-bar"))
  );
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  if (!notification) {
    return null;
  }

  const config = STATUS_CONFIG[notification.type];
  const Icon = config.icon;
  const actions = getActions(notification);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2.5 shadow-[var(--theme-shadow-ambient)]",
        config.containerClass,
        className
      )}
      role="status"
      aria-live="polite"
    >
      <Icon className={cn("h-4 w-4 shrink-0", config.iconClass)} aria-hidden="true" />

      <div className="min-w-0 flex-1">
        {notification.title && (
          <p
            className={cn(
              "text-xs font-mono uppercase tracking-wide leading-tight",
              config.titleClass
            )}
          >
            {notification.title}
          </p>
        )}
        <div className="text-xs leading-snug text-daintree-text/90">{notification.message}</div>
      </div>

      {actions.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          {actions.map((action, index) => (
            <button
              key={`${action.label}-${index}`}
              type="button"
              onClick={() => {
                void action.onClick();
              }}
              className={cn(
                "h-7 rounded-[var(--radius-sm)] px-3 text-xs font-medium transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent/60",
                action.variant === "secondary"
                  ? "border border-tint/15 bg-tint/5 text-daintree-text/80 hover:bg-tint/10 hover:text-daintree-text"
                  : "border border-status-info/30 bg-status-info/15 text-status-info hover:bg-status-info/20"
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {actions.length === 0 && (
        <button
          type="button"
          onClick={() => removeNotification(notification.id)}
          className="h-7 shrink-0 rounded-[var(--radius-sm)] border border-tint/10 bg-tint/5 px-2 text-xs text-daintree-text/60 transition-colors hover:bg-tint/10 hover:text-daintree-text/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent/60"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
