import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { restoreFocusTo } from "@/lib/accessibility";
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
import { SEVERITY_ICON } from "./InlineStatusBanner";

// Background uses the pre-baked status-surface wash (rgba, polarity-aware) and
// the border mixes the status color toward the opaque grid surface. Both avoid
// color-mix(..., transparent), which black-shifts on light backgrounds in oklab.
// Severity lives in the wash and the glyph only: severity-coloured type misses
// 4.5:1 on most themes, so the title and body stay on the neutral text ramp.
const STATUS_CONFIG = {
  success: {
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-success)_35%,var(--color-surface-grid))] bg-status-success-surface",
    iconClass: "text-status-success",
  },
  error: {
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-error)_35%,var(--color-surface-grid))] bg-status-error-surface",
    iconClass: "text-status-error",
  },
  info: {
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-info)_35%,var(--color-surface-grid))] bg-status-info-surface",
    iconClass: "text-status-info",
  },
  warning: {
    containerClass:
      "border-[color-mix(in_oklab,var(--color-status-warning)_35%,var(--color-surface-grid))] bg-status-warning-surface",
    iconClass: "text-status-warning",
  },
} satisfies Record<Notification["type"], { containerClass: string; iconClass: string }>;

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
    ((typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
      (typeof document !== "undefined" &&
        (document.body.getAttribute("data-reduce-animations") === "true" ||
          document.body.getAttribute("data-performance-mode") === "true")));

  // Two views of the same notification, deliberately out of step:
  //   - `presented` is what the strip draws. It lags `notification` only so the
  //     strip can keep painting through its exit fade, and switches straight
  //     to a replacement so the strip never blanks or changes height mid-swap.
  //   - `announced` is what the live region holds. It always starts empty and
  //     fills LIVE_REGION_SWAP_DELAY later, so AT hears a fresh addition to a
  //     region that already existed — including for a notification that was in
  //     the store before this component mounted.
  const [presented, setPresented] = useState<Notification | null>(notification ?? null);
  const [announced, setAnnounced] = useState<Notification | null>(null);
  const [isVisible, setIsVisible] = useState(prefersReducedMotion && notification !== undefined);
  const exitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryFrameRef = useRef<number | null>(null);
  const swapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The newest store copy of the notification, so an announcement that lands
  // after a same-id revision speaks the revision, not what was queued.
  const latestRef = useRef<Notification | undefined>(notification);

  const cardRef = useRef<HTMLDivElement>(null);
  // Whether keyboard focus is on one of the strip's controls, and where it came
  // from. When the notification leaves (dismissed, actioned, replaced) the
  // control goes with it, and Chromium drops focus on <body> without a blur —
  // so focus is handed back to where the user was working instead.
  const focusWithinRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const handleFocusCapture = (e: React.FocusEvent) => {
    const card = cardRef.current;
    if (!card) return;
    focusWithinRef.current = true;
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !card.contains(from)) returnFocusRef.current = from;
  };
  const handleBlurCapture = (e: React.FocusEvent) => {
    const card = cardRef.current;
    if (!card) return;
    if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;
    if (e.relatedTarget) focusWithinRef.current = false;
  };
  const releaseFocus = () => {
    if (!focusWithinRef.current) return;
    focusWithinRef.current = false;
    const region = cardRef.current?.closest<HTMLElement>('[role="region"]');
    restoreFocusTo(returnFocusRef.current, region);
  };

  useEffect(() => {
    if (!notification) {
      // Notification cleared: cancel any in-flight entry rAF or swap timer
      // (either would otherwise re-open the bar mid-collapse), hand focus back
      // before the controls go inert, collapse, then unmount content after the
      // exit window.
      if (entryFrameRef.current !== null) {
        cancelAnimationFrame(entryFrameRef.current);
        entryFrameRef.current = null;
      }
      if (swapTimeoutRef.current !== null) {
        clearTimeout(swapTimeoutRef.current);
        swapTimeoutRef.current = null;
      }
      releaseFocus();
      setIsVisible(false);
      if (exitTimeoutRef.current !== null) clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = setTimeout(() => {
        exitTimeoutRef.current = null;
        setPresented(null);
        setAnnounced(null);
      }, BANNER_EXIT_DURATION);
      return;
    }

    // Notification present — cancel any in-flight exit so we don't tear down.
    if (exitTimeoutRef.current !== null) {
      clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }

    const isReplacement = presented !== null && presented.id !== notification.id;

    // VoiceOver buffer flush: clear the live region first, wait ~150ms, then
    // re-populate so AT picks up the change as a fresh announcement. The delay
    // is a screen-reader concern, NOT motion — do not gate it on
    // prefers-reduced-motion. A third notification arriving mid-gap retargets
    // the pending announcement, so only the latest is spoken.
    setPresented(notification);
    setAnnounced(null);
    if (swapTimeoutRef.current !== null) clearTimeout(swapTimeoutRef.current);
    swapTimeoutRef.current = setTimeout(() => {
      swapTimeoutRef.current = null;
      const latest = latestRef.current;
      setAnnounced(latest?.id === notification.id ? latest : notification);
    }, LIVE_REGION_SWAP_DELAY);

    if (entryFrameRef.current !== null) {
      cancelAnimationFrame(entryFrameRef.current);
      entryFrameRef.current = null;
    }
    // A replacement arriving mid-exit re-opens the strip at once; so does
    // anything under reduced motion, where the transition is zeroed anyway.
    // A first entry opens on the next frame so the browser sees the collapsed
    // state before transitioning.
    if (isReplacement || prefersReducedMotion) {
      setIsVisible(true);
    } else {
      entryFrameRef.current = requestAnimationFrame(() => {
        entryFrameRef.current = null;
        setIsVisible(true);
      });
    }
  }, [notification?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The store can revise a notification in place — new message, new actions,
  // same id. Pick that up without replaying the entry or the swap gap.
  useEffect(() => {
    latestRef.current = notification;
    if (!notification) return;
    setPresented((p) => (p && p.id === notification.id ? notification : p));
    setAnnounced((a) => (a && a.id === notification.id ? notification : a));
  }, [notification]);

  // A replacement or a same-id revision can unmount the focused action (its
  // label keys it). If that left focus on <body>, hand it back rather than
  // stranding the user. Runs after every render: the controls can change
  // without the id doing so.
  useEffect(() => {
    if (!focusWithinRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    releaseFocus();
  });

  // Refresh the dwell lock whenever the presented notification changes.
  // Uses a layout effect so the lock is set before paint — a contender
  // arriving in the same render cycle as the first mount cannot preempt
  // before the dwell guard is in place.
  useLayoutEffect(() => {
    if (dwellTimeoutRef.current !== null) {
      clearTimeout(dwellTimeoutRef.current);
      dwellTimeoutRef.current = null;
    }
    if (!presented) {
      lockedIdRef.current = undefined;
      return;
    }
    lockedIdRef.current = presented.id;
    const firstShownAt = presented.firstShownAt ?? Date.now();
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
  }, [presented?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const config = presented ? STATUS_CONFIG[presented.type] : null;
  const Icon = presented ? SEVERITY_ICON[presented.type] : null;
  const actions = presented ? getActions(presented) : [];

  // While not visible (entry pre-rAF or mid-exit), the bar is visually
  // collapsed but still in the DOM. Keep the wrapper out of the accessibility
  // tree's "imperceptible" state (no `inert`) so the live-region announcement
  // fires when content lands. Suppress focus/click on the controls instead.
  const interactionGuard = isVisible ? {} : { tabIndex: -1, "aria-hidden": true as const };
  const buttonPointerClass = isVisible ? undefined : "pointer-events-none";

  return (
    <div
      data-testid="grid-notification-bar"
      className={cn(
        // Height snaps rather than animates: easing the strip's height would
        // resize every terminal beneath it on every frame.
        "grid-notification-wrapper shrink-0 overflow-hidden transition-[opacity]",
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
        ref={cardRef}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
        className={cn(
          // Laid out like the InlineStatusBanner strips stacked beneath it:
          // controls trail the text, and drop beneath it — aligned past the
          // glyph, dismiss holding the right edge — once the grid is too
          // narrow for a sentence and two actions to share a row.
          "@container/banner relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[var(--radius-sm)] border px-3 py-2",
          config?.containerClass,
          className
        )}
      >
        {/* Live region: text only, always mounted, visually hidden. APG
         *  anti-pattern to nest the controls here, and keeping it separate from
         *  the visible text is what lets the strip hold its content through
         *  the announcement gap. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announced && (
            <>
              {announced.title && <span>{announced.title}. </span>}
              <span>{announced.message}</span>
            </>
          )}
        </div>

        {presented && Icon && config && (
          <div aria-hidden="true" className="flex min-w-0 flex-1 items-start gap-2">
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", config.iconClass)} />
            <div className="min-w-0 flex-1 break-words">
              {presented.title ? (
                <>
                  <p className="text-sm font-medium text-text-primary">{presented.title}</p>
                  <div className="mt-0.5 text-xs text-text-secondary">{presented.message}</div>
                </>
              ) : (
                <div className="text-sm text-text-primary">{presented.message}</div>
              )}
            </div>
          </div>
        )}

        {/* Controls: action buttons first, dismiss trailing. Dismiss is always
         *  present — the grid bar carries signals from outside the visible UI,
         *  so the user must be able to clear one that is already handled or
         *  irrelevant without waiting for a duration persistent notifications
         *  do not have. Same Button mapping as InlineStatusBanner: the
         *  recommended action is the outlined one, the alternative is ghost,
         *  and severity stays in the wash rather than on the buttons. */}
        {presented && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1",
              // Only a row with actions drops; a lone dismiss always trails the
              // text. 40rem, not the sibling strips' 52rem: this bar carries two
              // labelled actions beside a two-line sentence comfortably at the
              // width a laptop grid leaves once the sidebar is open.
              actions.length > 0 &&
                "@max-[40rem]/banner:basis-full @max-[40rem]/banner:flex-wrap @max-[40rem]/banner:gap-y-1 @max-[40rem]/banner:pl-6"
            )}
          >
            {actions.map((action, index) => (
              <Button
                key={`${action.label}-${index}`}
                variant={action.variant === "secondary" ? "ghost" : "outline"}
                size="sm"
                // Forced colours flatten outline and ghost to the same border;
                // this hook restores the primary's heavier one (src/index.css).
                data-notification-action={action.variant ?? "primary"}
                onClick={() => {
                  void action.onClick();
                }}
                className={buttonPointerClass}
                {...interactionGuard}
              >
                {action.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => removeNotification(presented.id)}
              aria-label="Dismiss"
              className={cn(
                actions.length > 0 && "@max-[40rem]/banner:ml-auto",
                buttonPointerClass
              )}
              {...interactionGuard}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
