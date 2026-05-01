import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { BANNER_ENTER_DURATION, BANNER_EXIT_DURATION } from "@/lib/animationUtils";
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

  // displayedNotification lags `notification` so the bar can keep rendering
  // through the exit animation after the store entry is already gone.
  const [displayedNotification, setDisplayedNotification] = useState<Notification | null>(
    notification ?? null
  );
  const [isVisible, setIsVisible] = useState(false);
  const exitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (notification) {
      // New or replacing notification: cancel any in-flight exit, swap content
      // synchronously, and start fresh entry on the next frame so the browser
      // sees the h-0/opacity-0 state before transitioning.
      if (exitTimeoutRef.current !== null) {
        clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      setDisplayedNotification(notification);

      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
      }
      entryFrameRef.current = requestAnimationFrame(() => {
        entryFrameRef.current = null;
        setIsVisible(true);
      });
      return;
    }

    // Notification cleared: cancel any in-flight entry rAF (would otherwise
    // re-open the bar mid-collapse), then collapse and unmount content after
    // the exit window. Guard against re-entry by clearing the timer in cleanup.
    if (entryFrameRef.current !== null) {
      cancelAnimationFrame(entryFrameRef.current);
      entryFrameRef.current = null;
    }
    setIsVisible(false);
    if (exitTimeoutRef.current !== null) {
      clearTimeout(exitTimeoutRef.current);
    }
    exitTimeoutRef.current = setTimeout(() => {
      exitTimeoutRef.current = null;
      setDisplayedNotification(null);
    }, BANNER_EXIT_DURATION);
  }, [notification?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (exitTimeoutRef.current !== null) {
        clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
        entryFrameRef.current = null;
      }
    };
  }, []);

  if (!displayedNotification) {
    return null;
  }

  const config = STATUS_CONFIG[displayedNotification.type];
  const Icon = config.icon;
  const actions = getActions(displayedNotification);

  // While not visible (entry pre-rAF or mid-exit), the bar is visually
  // collapsed but still in the DOM. Keep the wrapper out of the accessibility
  // tree's "imperceptible" state (no `inert`) so the live-region announcement
  // fires when content lands. Suppress focus/click on action buttons instead.
  const interactionGuard = isVisible ? {} : { tabIndex: -1, "aria-hidden": true as const };
  const buttonPointerClass = isVisible ? "" : "pointer-events-none";

  return (
    <div
      className={cn(
        "grid-notification-wrapper shrink-0 overflow-hidden transition-[height,opacity]",
        isVisible
          ? "h-auto opacity-100 ease-[var(--ease-snappy)]"
          : "h-0 opacity-0 ease-[var(--ease-exit)]"
      )}
      style={{
        transitionDuration: `${isVisible ? BANNER_ENTER_DURATION : BANNER_EXIT_DURATION}ms`,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "flex items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2.5 shadow-[var(--theme-shadow-ambient)]",
          config.containerClass,
          className
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", config.iconClass)} aria-hidden="true" />

        <div className="min-w-0 flex-1">
          {displayedNotification.title && (
            <p
              className={cn(
                "text-xs font-mono uppercase tracking-wide leading-tight",
                config.titleClass
              )}
            >
              {displayedNotification.title}
            </p>
          )}
          <div className="text-xs leading-snug text-daintree-text/90">
            {displayedNotification.message}
          </div>
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
                    : "border border-status-info/30 bg-status-info/15 text-status-info hover:bg-status-info/20",
                  buttonPointerClass
                )}
                {...interactionGuard}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {actions.length === 0 && (
          <button
            type="button"
            onClick={() => removeNotification(displayedNotification.id)}
            className={cn(
              "h-7 shrink-0 rounded-[var(--radius-sm)] border border-tint/10 bg-tint/5 px-2 text-xs text-daintree-text/60 transition-colors hover:bg-tint/10 hover:text-daintree-text/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent/60",
              buttonPointerClass
            )}
            {...interactionGuard}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
