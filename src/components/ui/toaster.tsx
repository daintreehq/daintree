import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
  MoreHorizontal,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";
import { useShallow } from "zustand/react/shallow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";

const ACCENT_CLASS: Record<string, string> = {
  success: "border-l-status-success",
  error: "border-l-status-error",
  info: "border-l-status-info",
  warning: "border-l-status-warning",
};

type IconConfig = { Icon: LucideIcon; className: string };

const DEFAULT_ICON_CONFIG: IconConfig = { Icon: Info, className: "text-status-info" };

const TYPE_ICON_CONFIG: Record<string, IconConfig> = {
  success: { Icon: CheckCircle2, className: "text-status-success" },
  error: { Icon: XCircle, className: "text-status-error" },
  info: DEFAULT_ICON_CONFIG,
  warning: { Icon: AlertTriangle, className: "text-status-warning" },
};

/**
 * Hard cap on total visible time for any toast, regardless of how many
 * coalesced updates restart its timer. Bounds chatty same-entity bursts
 * (e.g. agent state churn under #5863).
 */
const MAX_VISIBLE_DURATION_MS = 15000;
const VISIBLE_DURATION_MULTIPLIER = 3;

function Toast({ notification }: { notification: Notification }) {
  const { dismissNotification, removeNotification } = useNotificationStore(
    useShallow((state) => ({
      dismissNotification: state.dismissNotification,
      removeNotification: state.removeNotification,
    }))
  );
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const toastRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    prevFocusRef.current = document.activeElement;
  }, []);

  useEffect(() => {
    if (
      import.meta.env.DEV &&
      typeof notification.message !== "string" &&
      !notification.inboxMessage
    ) {
      logError(
        "[Toaster] non-string message without inboxMessage — aria-live announcement will be empty"
      );
    }
  }, [notification.id, notification.updatedAt, notification.message, notification.inboxMessage]);

  useEffect(() => {
    const handle = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(handle);
  }, []);

  const restoreFocus = useCallback(() => {
    if (toastRef.current?.contains(document.activeElement)) {
      (prevFocusRef.current as HTMLElement | null)?.focus?.();
    }
  }, []);

  const handleDismiss = useCallback(() => {
    // If the notification is already dismissed, this click came in during the
    // exit fade after an eviction (or a double-click race). Skip the
    // user-dismiss callback so eviction/reentrancy don't fire onDismiss.
    if (notification.dismissed) return;
    restoreFocus();
    // Fire onDismiss exactly once, before marking dismissed, so callers see
    // a clean user-driven signal distinct from MAX_VISIBLE_TOASTS eviction.
    try {
      notification.onDismiss?.();
    } catch (err) {
      logError("[Toast] onDismiss handler threw", err);
    }
    dismissNotification(notification.id);
    setIsVisible(false);
    setTimeout(() => removeNotification(notification.id), getUiTransitionDuration("exit"));
  }, [notification, dismissNotification, removeNotification, restoreFocus]);

  useEffect(() => {
    if (notification.dismissed && isVisible) {
      restoreFocus();
      setIsVisible(false);
      setTimeout(() => removeNotification(notification.id), getUiTransitionDuration("exit"));
    }
  }, [notification.dismissed, notification.id, isVisible, removeNotification, restoreFocus]);

  // Latest-ref for handleDismiss so the auto-dismiss effect doesn't restart
  // every time the callback identity changes — the effect should restart only
  // on contentKey (true message change) or when pause/duration toggles.
  const dismissRef = useRef(handleDismiss);
  useLayoutEffect(() => {
    dismissRef.current = handleDismiss;
  });

  useEffect(() => {
    // !notification.duration is sticky (covers both 0 and undefined): a direct
    // addNotification caller bypassing notify()'s severity defaults stays
    // sticky rather than silently auto-dismissing at 0ms.
    if (!notification.duration || isPaused) return;
    const duration = notification.duration;
    const cap = Math.min(duration * VISIBLE_DURATION_MULTIPLIER, MAX_VISIBLE_DURATION_MS);
    const deadline = (notification.firstShownAt ?? Date.now()) + cap;
    const delay = Math.min(duration, Math.max(0, deadline - Date.now()));
    const timer = setTimeout(() => dismissRef.current(), delay);
    return () => clearTimeout(timer);
  }, [notification.duration, notification.contentKey, notification.firstShownAt, isPaused]);

  const accentClass = ACCENT_CLASS[notification.type] ?? "border-l-status-info";
  const { Icon, className: iconClassName } =
    TYPE_ICON_CONFIG[notification.type] ?? DEFAULT_ICON_CONFIG;

  return (
    <div
      ref={toastRef}
      className={cn(
        "group pointer-events-auto relative flex w-full max-w-[360px] items-start gap-3",
        "rounded-[var(--radius-sm)] border-l-[3px] border border-tint/[0.08]",
        "bg-surface-panel/85 backdrop-blur-xl",
        "px-3 py-2.5 pr-2",
        "text-sm text-daintree-text",
        "shadow-[var(--theme-shadow-floating)]",
        "ring-1 ring-inset ring-tint/[0.05]",
        "transition-[transform,opacity]",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        accentClass
      )}
      style={{
        transitionDuration: `${isVisible ? UI_ENTER_DURATION : UI_EXIT_DURATION}ms`,
        transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
      }}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsPaused(false);
        }
      }}
      role={notification.type === "error" ? "alert" : "status"}
    >
      <div className={cn("shrink-0 mt-0.5", iconClassName)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 space-y-1 min-w-0 py-0.5">
        {notification.title ? (
          <h4 className="font-medium leading-tight tracking-tight text-xs text-daintree-text flex items-center gap-1.5">
            <span className="min-w-0 truncate">{notification.title}</span>
            {notification.count != null && notification.count > 1 && (
              <span
                aria-label={`${notification.count} events`}
                className="shrink-0 rounded-full bg-tint/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums"
              >
                ×{notification.count}
              </span>
            )}
          </h4>
        ) : notification.count != null && notification.count > 1 ? (
          <div>
            <span
              aria-label={`${notification.count} events`}
              className="inline-block rounded-full bg-tint/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums"
            >
              ×{notification.count}
            </span>
          </div>
        ) : null}
        {typeof notification.message !== "string" && notification.inboxMessage ? (
          <>
            <span className="sr-only">{notification.inboxMessage}</span>
            <div
              aria-hidden="true"
              className="text-xs text-daintree-text/70 leading-snug break-words"
            >
              {notification.message}
            </div>
          </>
        ) : (
          <div className="text-xs text-daintree-text/70 leading-snug break-words">
            {notification.message}
          </div>
        )}
        {(() => {
          const actions = [
            ...(notification.actions ?? []),
            ...(notification.action ? [notification.action] : []),
          ];
          if (actions.length === 0) return null;
          return (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => {
                    action.onClick();
                    handleDismiss();
                  }}
                  className={cn(
                    "px-2.5 py-1 rounded-[var(--radius-xs)]",
                    "text-xs font-medium",
                    "bg-status-info/10 text-status-info",
                    "hover:bg-status-info/20 transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          );
        })()}
      </div>

      {notification.context?.projectId && (
        <DropdownMenu onOpenChange={(open) => setIsPaused(open)}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Notification options"
              className={cn(
                "shrink-0 rounded-[var(--radius-xs)]",
                "h-6 w-6 flex items-center justify-center",
                "text-daintree-text/40 transition-colors duration-150",
                "hover:text-daintree-text/80 hover:bg-tint/10",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            <DropdownMenuItem
              onSelect={() => {
                const projectId = notification.context?.projectId;
                if (!projectId) return;
                handleDismiss();
                void actionService.dispatch("project.muteNotifications", { projectId });
              }}
            >
              Mute project notifications
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        className={cn(
          "shrink-0 rounded-[var(--radius-xs)]",
          "h-6 w-6 flex items-center justify-center",
          "text-daintree-text/40 transition-colors duration-150",
          "hover:text-daintree-text/80 hover:bg-tint/10",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
      className="fixed top-14 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--portal-right-offset, 0px))" }}
    >
      {[...toastNotifications].reverse().map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>,
    document.body
  );
}
