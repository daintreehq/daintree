import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";

const STATUS_CONFIG = {
  success: {
    icon: CheckCircle2,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-success)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-success)_14%,transparent),color-mix(in_oklab,var(--color-status-success)_6%,transparent))]",
    iconClass: "text-[var(--color-status-success)]",
    titleClass: "text-[var(--color-status-success)]",
  },
  error: {
    icon: XCircle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-error)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-error)_14%,transparent),color-mix(in_oklab,var(--color-status-error)_6%,transparent))]",
    iconClass: "text-[var(--color-status-error)]",
    titleClass: "text-[var(--color-status-error)]",
  },
  info: {
    icon: Info,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-info)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-info)_14%,transparent),color-mix(in_oklab,var(--color-status-info)_6%,transparent))]",
    iconClass: "text-[var(--color-status-info)]",
    titleClass: "text-[var(--color-status-info)]",
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-warning)_35%,transparent)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--color-status-warning)_14%,transparent),color-mix(in_oklab,var(--color-status-warning)_6%,transparent))]",
    iconClass: "text-[var(--color-status-warning)]",
    titleClass: "text-[var(--color-status-warning)]",
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
  const notification = useNotificationStore((state) =>
    state.notifications.find((item) => item.placement === "grid-bar")
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
        "flex items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.2)]",
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
        <div className="text-xs leading-snug text-canopy-text/90">{notification.message}</div>
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
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent/60",
                action.variant === "secondary"
                  ? "border border-white/15 bg-white/5 text-canopy-text/80 hover:bg-white/10 hover:text-canopy-text"
                  : "border border-canopy-accent/40 bg-canopy-accent/15 text-canopy-accent hover:bg-canopy-accent/25"
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
          className="h-7 shrink-0 rounded-[var(--radius-sm)] border border-white/10 bg-white/5 px-2 text-xs text-canopy-text/60 transition-colors hover:bg-white/10 hover:text-canopy-text/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent/60"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
