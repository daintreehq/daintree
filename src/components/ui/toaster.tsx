import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle2, XCircle, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";

const STATUS_CONFIG = {
  success: {
    icon: CheckCircle2,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-success)_18%,transparent)] border-[color:color-mix(in_oklab,var(--color-status-success)_30%,transparent)] backdrop-blur-sm",
    accentClass: "text-[var(--color-status-success)]",
  },
  error: {
    icon: XCircle,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-error)_18%,transparent)] border-[color:color-mix(in_oklab,var(--color-status-error)_30%,transparent)] backdrop-blur-sm",
    accentClass: "text-[var(--color-status-error)]",
  },
  info: {
    icon: Info,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-info)_18%,transparent)] border-[color:color-mix(in_oklab,var(--color-status-info)_30%,transparent)] backdrop-blur-sm",
    accentClass: "text-[var(--color-status-info)]",
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-warning)_18%,transparent)] border-[color:color-mix(in_oklab,var(--color-status-warning)_30%,transparent)] backdrop-blur-sm",
    accentClass: "text-[var(--color-status-warning)]",
  },
};

function Toast({ notification }: { notification: Notification }) {
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
  }, []);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => removeNotification(notification.id), 300);
  }, [notification.id, removeNotification]);

  useEffect(() => {
    if (notification.duration === 0 || isPaused) return;

    const timer = setTimeout(handleDismiss, notification.duration || 5000);
    return () => clearTimeout(timer);
  }, [notification.duration, handleDismiss, isPaused]);

  const config = STATUS_CONFIG[notification.type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "pointer-events-auto relative flex w-full max-w-[400px] items-start gap-2.5",
        "rounded-[var(--radius-sm)] border",
        "px-3 py-2.5 pr-10",
        "text-sm text-canopy-text",
        "shadow-[0_4px_12px_rgba(0,0,0,0.2)]",
        "transition-[transform,opacity] duration-300 ease-out",
        isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        config.containerClass
      )}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      role="alert"
    >
      <div className={cn("mt-0.5 shrink-0", config.accentClass)}>
        <Icon className="h-4 w-4" />
      </div>

      <div className="flex-1 space-y-1 min-w-0">
        {notification.title && (
          <h4
            className={cn(
              "font-medium leading-tight tracking-tight text-xs font-mono",
              config.accentClass
            )}
          >
            {notification.title}
          </h4>
        )}
        <div className="text-xs text-canopy-text/90 leading-snug break-words">
          {notification.message}
        </div>
        {notification.action && (
          <button
            type="button"
            onClick={() => {
              notification.action?.onClick();
              handleDismiss();
            }}
            className={cn(
              "mt-1.5 px-2.5 py-1 rounded-[var(--radius-xs)]",
              "text-xs font-medium",
              "bg-canopy-accent/10 text-canopy-accent",
              "hover:bg-canopy-accent/20 transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            {notification.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        className={cn(
          "absolute right-1.5 top-1.5 rounded-[var(--radius-xs)]",
          "h-6 w-6 flex items-center justify-center",
          "text-canopy-text/60 transition-colors",
          "hover:text-canopy-text/90 hover:bg-white/10",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const notifications = useNotificationStore((state) => state.notifications);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const toastNotifications = notifications.filter(
    (notification) => notification.placement !== "grid-bar"
  );

  if (!mounted || toastNotifications.length === 0) return null;

  return createPortal(
    <div
      className="fixed bottom-6 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[420px] pointer-events-none p-4"
      style={{ right: "calc(var(--sidecar-right-offset, 0px))" }}
    >
      {toastNotifications.map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>,
    document.body
  );
}
