import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BANNER_ENTER_DURATION,
  BANNER_EXIT_DURATION,
  LIVE_REGION_SWAP_DELAY,
} from "@/lib/animationUtils";
import {
  GRID_BAR_DWELL_FLOOR_MS,
  selectGridBarNotification,
  useNotificationStore,
  type Notification,
} from "@/store/notificationStore";

// Background uses the pre-baked status-surface wash (rgba, polarity-aware) and
// the border mixes the status color toward the opaque grid surface. Both avoid
// color-mix(..., transparent), which black-shifts on light backgrounds in oklab.
const STATUS_CONFIG = {
  success: {
    icon: CheckCircle2,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-success)_35%,var(--color-surface-grid))] bg-status-success-surface",
    iconClass: "text-status-success",
    titleClass: "text-status-success",
  },
  error: {
    icon: XCircle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-error)_35%,var(--color-surface-grid))] bg-status-error-surface",
    iconClass: "text-status-error",
    titleClass: "text-status-error",
  },
  info: {
    icon: Info,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-info)_35%,var(--color-surface-grid))] bg-status-info-surface",
    iconClass: "text-status-info",
    titleClass: "text-status-info",
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-warning)_35%,var(--color-surface-grid))] bg-status-warning-surface",
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
  // Tracks the id currently visible to the user so the selector can enforce
  // the dwell floor. A ref (not state) avoids spurious re-renders when the
  // lock target changes — the selector reads the ref on every render.
  const lockedIdRef = useRef<string | undefined>(undefined);
  // Bumped by the dwell timeout to force a selector re-evaluation after
  // dwell expires. The store-subscription path won't fire on its own when
  // only time has passed.
  const [, setDwellTick] = useState(0);
  const dwellTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notification = useNotificationStore((state) =>
    selectGridBarNotification(state.notifications, Date.now(), lockedIdRef.current)
  );
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Mirrors InlineStatusBanner.tsx — synchronous read at render time is the
  // codebase precedent for non-SSR Electron consumers. Three signals collapse
  // to one: the OS-level media query, plus two app-set body attributes that
  // override it (settings → reduced-animations, perf governor → performance-mode).
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      (typeof document !== "undefined" &&
        (document.body.getAttribute("data-reduce-animations") === "true" ||
          document.body.getAttribute("data-performance-mode") === "true")));

  // displayedNotification lags `notification` so the bar can keep rendering
  // through the exit animation after the store entry is already gone, and so
  // the live region can be cleared mid-swap without unmounting.
  const initialNotification = notification ?? null;
  const [displayedNotification, setDisplayedNotification] = useState<Notification | null>(
    initialNotification
  );
  const [isVisible, setIsVisible] = useState(prefersReducedMotion && initialNotification !== null);
  const exitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryFrameRef = useRef<number | null>(null);
  const swapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notification) {
      // Notification cleared: cancel any in-flight entry rAF or swap timer
      // (either would otherwise re-open the bar mid-collapse), collapse, then
      // unmount content after the exit window.
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
        entryFrameRef.current = null;
      }
      if (swapTimeoutRef.current !== null) {
        clearTimeout(swapTimeoutRef.current);
        swapTimeoutRef.current = null;
      }
      setIsVisible(false);
      if (exitTimeoutRef.current !== null) clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = setTimeout(() => {
        exitTimeoutRef.current = null;
        setDisplayedNotification(null);
      }, BANNER_EXIT_DURATION);
      return;
    }

    // Notification present — cancel any in-flight exit so we don't tear down.
    if (exitTimeoutRef.current !== null) {
      clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }

    // Replacement detection: there is (or was) live-region content that needs
    // to be flushed before the new notification is announced. Covers two cases:
    //   - displayed is non-null with a different id (active swap)
    //   - a swap is already in flight (live region cleared, target pending)
    //     and a third notification arrives — retarget the pending swap.
    const isReplacement =
      (displayedNotification !== null && displayedNotification.id !== notification.id) ||
      swapTimeoutRef.current !== null;

    if (isReplacement) {
      // VoiceOver buffer flush: clear the live region first, wait ~150ms, then
      // re-populate so AT picks up the change as a fresh announcement. The
      // delay is a screen-reader concern, NOT motion — do not gate it on
      // prefers-reduced-motion.
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
        entryFrameRef.current = null;
      }
      if (swapTimeoutRef.current !== null) {
        clearTimeout(swapTimeoutRef.current);
      }
      setDisplayedNotification(null);
      // Ensure the bar stays open during the swap gap (e.g. if a swap arrives
      // mid-exit). Idempotent when already true.
      setIsVisible(true);
      swapTimeoutRef.current = setTimeout(() => {
        swapTimeoutRef.current = null;
        setDisplayedNotification(notification);
      }, LIVE_REGION_SWAP_DELAY);
      return;
    }

    // First entry from an empty live region: set content and animate in on the
    // next frame so the browser sees the h-0/opacity-0 state before transitioning.
    // Skip the rAF under reduced motion — the transition is zeroed out anyway.
    setDisplayedNotification(notification);
    if (entryFrameRef.current !== null) {
      cancelAnimationFrame(entryFrameRef.current);
      entryFrameRef.current = null;
    }
    if (prefersReducedMotion) {
      setIsVisible(true);
    } else {
      entryFrameRef.current = requestAnimationFrame(() => {
        entryFrameRef.current = null;
        setIsVisible(true);
      });
    }
  }, [notification?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh the dwell lock whenever the displayed notification changes.
  // Uses a layout effect so the lock is set before paint — a contender
  // arriving in the same render cycle as the first mount cannot preempt
  // before the dwell guard is in place.
  useLayoutEffect(() => {
    if (dwellTimeoutRef.current !== null) {
      clearTimeout(dwellTimeoutRef.current);
      dwellTimeoutRef.current = null;
    }
    if (!displayedNotification) {
      lockedIdRef.current = undefined;
      return;
    }
    lockedIdRef.current = displayedNotification.id;
    const firstShownAt = displayedNotification.firstShownAt ?? Date.now();
    const dwellRemaining = firstShownAt + GRID_BAR_DWELL_FLOOR_MS - Date.now();
    if (dwellRemaining <= 0) {
      // Already past the floor; nudge a re-render so the selector can pick
      // a higher-severity candidate that arrived during the prior render.
      setDwellTick((t) => t + 1);
      return;
    }
    dwellTimeoutRef.current = setTimeout(() => {
      dwellTimeoutRef.current = null;
      setDwellTick((t) => t + 1);
    }, dwellRemaining);
  }, [displayedNotification?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (swapTimeoutRef.current !== null) {
        clearTimeout(swapTimeoutRef.current);
        swapTimeoutRef.current = null;
      }
      if (dwellTimeoutRef.current !== null) {
        clearTimeout(dwellTimeoutRef.current);
        dwellTimeoutRef.current = null;
      }
    };
  }, []);

  const config = displayedNotification ? STATUS_CONFIG[displayedNotification.type] : null;
  const Icon = config?.icon;
  const actions = displayedNotification ? getActions(displayedNotification) : [];

  // While not visible (entry pre-rAF or mid-exit), the bar is visually
  // collapsed but still in the DOM. Keep the wrapper out of the accessibility
  // tree's "imperceptible" state (no `inert`) so the live-region announcement
  // fires when content lands. Suppress focus/click on action buttons instead.
  const interactionGuard = isVisible ? {} : { tabIndex: -1, "aria-hidden": true as const };
  const buttonPointerClass = isVisible ? "" : "pointer-events-none";

  return (
    <div
      data-testid="grid-notification-bar"
      className={cn(
        "grid-notification-wrapper shrink-0 overflow-hidden transition-[height,opacity]",
        isVisible
          ? "h-auto opacity-100 ease-[var(--ease-snappy)]"
          : "h-0 opacity-0 ease-[var(--ease-exit)]"
      )}
      style={{
        transitionDuration: prefersReducedMotion
          ? "0ms"
          : `${isVisible ? BANNER_ENTER_DURATION : BANNER_EXIT_DURATION}ms`,
      }}
    >
      <div
        className={cn(
          "flex items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2.5 shadow-[var(--theme-shadow-ambient)]",
          config?.containerClass,
          className
        )}
      >
        {/* Live region: text content only. APG anti-pattern to nest action
         *  buttons here — they render as siblings below. Always mounted (even
         *  when empty) so AT registers the region on page load rather than
         *  ignoring a late-mounted live region. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {displayedNotification && Icon && config && (
            <>
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
                <div className="text-xs leading-snug text-text-primary">
                  {displayedNotification.message}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Controls: action buttons first, dismiss trailing. Dismiss is always
         *  present — the grid bar carries signals from outside the visible UI,
         *  so the user must be able to clear one that is already handled or
         *  irrelevant without waiting for a duration persistent notifications
         *  do not have. Ordering matches Toast (actions, then close). */}
        {displayedNotification && (
          <div className="flex shrink-0 items-center gap-1.5">
            {actions.map((action, index) => (
              <button
                key={`${action.label}-${index}`}
                type="button"
                onClick={() => {
                  void action.onClick();
                }}
                className={cn(
                  "h-7 rounded-[var(--radius-xs)] px-3 text-xs font-medium transition-colors",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent/60",
                  action.variant === "secondary"
                    ? "border border-tint/15 bg-tint/5 text-daintree-text/80 hover:bg-tint/10 hover:text-text-primary"
                    : "border border-status-info/30 bg-status-info/15 text-status-info hover:bg-status-info/20",
                  buttonPointerClass
                )}
                {...interactionGuard}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => removeNotification(displayedNotification.id)}
              aria-label="Dismiss"
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-daintree-text/60 transition-colors hover:bg-tint/10 hover:text-daintree-text/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent/60",
                buttonPointerClass
              )}
              {...interactionGuard}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
