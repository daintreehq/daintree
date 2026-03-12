import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotificationStore, type Notification } from "@/store/notificationStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useShallow } from "zustand/react/shallow";

const ACCENT_CLASS: Record<string, string> = {
  success: "border-l-status-success",
  error: "border-l-status-error",
  info: "border-l-status-info",
  warning: "border-l-status-warning",
};

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
    const text = typeof notification.message === "string"
      ? notification.message
      : (notification.inboxMessage ?? "");
    if (!text) return;
    const fullText = notification.title ? `${notification.title}: ${text}` : text;
    const priority = notification.type === "error" ? "assertive" : "polite";
    useAnnouncerStore.getState().announce(fullText, priority);
  }, [notification.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    restoreFocus();
    dismissNotification(notification.id);
    setIsVisible(false);
    setTimeout(() => removeNotification(notification.id), 300);
  }, [notification.id, dismissNotification, removeNotification, restoreFocus]);

  useEffect(() => {
    if (notification.dismissed && isVisible) {
      restoreFocus();
      setIsVisible(false);
      setTimeout(() => removeNotification(notification.id), 300);
    }
  }, [notification.dismissed, notification.id, isVisible, removeNotification, restoreFocus]);

  useEffect(() => {
    if (notification.duration === 0 || isPaused) return;
    const timer = setTimeout(handleDismiss, notification.duration || 3000);
    return () => clearTimeout(timer);
  }, [notification.duration, handleDismiss, isPaused]);

  const accentClass = ACCENT_CLASS[notification.type] ?? "border-l-status-info";

  return (
    <div
      ref={toastRef}
      className={cn(
        "group pointer-events-auto relative flex w-full max-w-[360px] items-start gap-3",
        "rounded-[var(--radius-sm)] border-l-[3px] border border-white/[0.08]",
        "bg-zinc-900/60 backdrop-blur-xl",
        "px-3 py-2.5 pr-2",
        "text-sm text-canopy-text",
        "shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
        "ring-1 ring-inset ring-white/[0.05]",
        "transition-[transform,opacity] duration-300 ease-out",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        accentClass
      )}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsPaused(false);
        }
      }}
      role="alert"
    >
      <div className="flex-1 space-y-1 min-w-0 py-0.5">
        {notification.title && (
          <h4 className="font-medium leading-tight tracking-tight text-xs text-canopy-text">
            {notification.title}
          </h4>
        )}
        <div className="text-xs text-canopy-text/70 leading-snug break-words">
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
          "shrink-0 rounded-[var(--radius-xs)]",
          "h-6 w-6 flex items-center justify-center",
          "text-canopy-text/40 transition-colors duration-150",
          "hover:text-canopy-text/80 hover:bg-white/10",
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
      className="fixed top-14 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--sidecar-right-offset, 0px))" }}
    >
      {[...toastNotifications].reverse().map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>,
    document.body
  );
}
