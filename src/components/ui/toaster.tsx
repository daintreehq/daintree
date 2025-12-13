import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle2, XCircle, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";

const STATUS_CONFIG = {
  success: {
    icon: CheckCircle2,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-success)_12%,transparent)] border-[var(--color-status-success)]/30",
    accentClass: "text-[var(--color-status-success)]",
  },
  error: {
    icon: XCircle,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border-[var(--color-status-error)]/30",
    accentClass: "text-[var(--color-status-error)]",
  },
  info: {
    icon: Info,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-info)_12%,transparent)] border-[var(--color-status-info)]/30",
    accentClass: "text-[var(--color-status-info)]",
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      "bg-[color-mix(in_oklab,var(--color-status-warning)_12%,transparent)] border-[var(--color-status-warning)]/30",
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
        "pointer-events-auto relative flex w-full max-w-[400px] items-start gap-3",
        "rounded-[var(--radius-lg)] border",
        "p-4 pr-10",
        "text-sm text-canopy-text",
        "shadow-lg",
        "transition-all duration-300 ease-out",
        isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        config.containerClass
      )}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      role="alert"
    >
      <div className={cn("mt-0.5 shrink-0", config.accentClass)}>
        <Icon className="h-5 w-5" />
      </div>

      <div className="flex-1 space-y-1 min-w-0">
        {notification.title && (
          <h4 className={cn("font-medium leading-none tracking-tight text-sm", config.accentClass)}>
            {notification.title}
          </h4>
        )}
        <div className="text-xs text-canopy-text/80 leading-relaxed break-words">
          {notification.message}
        </div>
      </div>

      <button
        onClick={handleDismiss}
        className={cn(
          "absolute right-2 top-2 rounded-[var(--radius-sm)] p-1",
          "text-canopy-text/40 transition-colors",
          "hover:text-canopy-text hover:bg-white/5",
          "focus:outline-none focus:ring-1 focus:ring-canopy-border"
        )}
      >
        <X className="h-4 w-4" />
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

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed bottom-6 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[420px] pointer-events-none p-4"
      style={{ right: "calc(var(--sidecar-right-offset, 0px))" }}
    >
      {notifications.map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>,
    document.body
  );
}
