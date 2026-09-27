import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
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
  DURATION_150,
  DURATION_200,
  DURATION_300,
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_ACTION_SUCCESS_DWELL_MS,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import {
  formatNotificationCountAriaLabel,
  formatNotificationCountGlyph,
} from "@/components/Notifications/notificationCount";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { useNotificationStore, type Notification } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";
import { EVENT_KIND_LABEL, isNotificationEventKind } from "@/lib/notify";
import { useEscapeStack } from "@/hooks/useEscapeStack";

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
 * (e.g. agent state churn under #5863). With severity defaults now at 5–8s,
 * a single tick never approaches this ceiling — it's a safety net for
 * coalesced bursts and over-length explicit durations, not a routine clamp.
 */
const MAX_VISIBLE_DURATION_MS = 15000;
const VISIBLE_DURATION_MULTIPLIER = 3;

function CountBadge({
  count,
  isBumping,
  onBumpEnd,
}: {
  count: number;
  isBumping: boolean;
  onBumpEnd: () => void;
}) {
  return (
    // The count is spoken as text inside the live region: an aria-label on a
    // plain span is not exposed, so the glyph alone would read as "times 5".
    <span
      data-testid="toast-coalesce-badge"
      className={cn(
        "shrink-0 rounded-full bg-tint/10 px-1.5 py-0.5 text-3xs font-medium leading-none text-text-secondary tabular-nums min-w-[3.5ch] text-center",
        isBumping && "animate-badge-bump"
      )}
      style={{ animationDuration: `${DURATION_150}ms` }}
      onAnimationEnd={(e) => {
        if (e.animationName === "badge-bump") onBumpEnd();
      }}
    >
      <span aria-hidden="true">{formatNotificationCountGlyph(count, "×")}</span>
      <span className="sr-only">{formatNotificationCountAriaLabel(count)}</span>
    </span>
  );
}

function Toast({ notification, isTopmost }: { notification: Notification; isTopmost: boolean }) {
  const { dismissNotification, removeNotification } = useNotificationStore(
    useShallow((state) => ({
      dismissNotification: state.dismissNotification,
      removeNotification: state.removeNotification,
    }))
  );
  const [isVisible, setIsVisible] = useState(false);
  // Track each pause source independently so the dismiss timer only resumes
  // when *every* reason has cleared. Collapsing them into a single boolean
  // races on mouseLeave: hover-grace would unpause while focus is still
  // inside the toast or while the options dropdown is open.
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusInside, setIsFocusInside] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  // Window blur pauses auto-dismiss (#10056): a toast racing its timer in a
  // blurred window dismisses unseen while its history entry says
  // `seenAsToast: true`. Initialized from `document.hasFocus()` at mount
  // (synchronous read — safe outside event handlers) so a toast born into a
  // blurred window starts paused; the listeners below are pure state flips
  // because `hasFocus()` is stale inside blur handlers in Chromium 148.
  const [isWindowBlurred, setIsWindowBlurred] = useState(
    () => typeof document !== "undefined" && !document.hasFocus()
  );
  // Paused time doesn't count against the visible-duration cap. The cap bounds
  // unattended time (see MAX_VISIBLE_DURATION_MS): a toast in a blurred window
  // isn't visible, and one under the pointer or focus is being read. Without
  // this credit, a pause outlasting the cap computes a 0ms delay on resume and
  // instant-dismisses the toast the user came back for (e.g. a watch-priority
  // toast born blurred, or one read with the pointer resting on it).
  const pausedAccumRef = useRef(0);
  const pausedSinceRef = useRef<number | null>(
    typeof document !== "undefined" && !document.hasFocus() ? Date.now() : null
  );
  const toastRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);

  type ActionStatus = "idle" | "loading" | "success";
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [activeActionIndex, setActiveActionIndex] = useState<number | null>(null);
  const [actionActivatedByKeyboard, setActionActivatedByKeyboard] = useState(false);
  // An action still running holds the toast: letting the timer dismiss it
  // mid-flight would drop the result (and its confirmation) on the floor.
  const isActionPending = activeActionIndex !== null && actionStatus !== "success";
  const isPaused =
    isHovered || isFocusInside || isDropdownOpen || isWindowBlurred || isActionPending;
  // Layout phase, so the credit is settled before the dismiss effect below
  // reads it in the same commit.
  useLayoutEffect(() => {
    if (isPaused) {
      if (pausedSinceRef.current === null) pausedSinceRef.current = Date.now();
    } else if (pausedSinceRef.current !== null) {
      pausedAccumRef.current += Date.now() - pausedSinceRef.current;
      pausedSinceRef.current = null;
    }
  }, [isPaused]);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Safety fallback for the count-badge bump animation: when reduced-motion or
  // performance mode forces `animation: none`, `animationend` never fires, so
  // `isCountBumping` would latch true. Mirrors NotificationCenterToolbarButton.
  const bumpFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Short grace before resuming the dismiss timer after the cursor leaves —
  // prevents accidental dismissal on small jitter or briefly crossing chrome.
  const mouseLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // While bursts of count-only updates arrive, set aria-busy on the live
  // region so AT (NVDA/ChromeVox; VoiceOver inconsistent) can suppress
  // intermediate announcements (#6427). Trailing 300ms inactivity window so
  // the final value is announced once the burst settles.
  const [isCountBusy, setIsCountBusy] = useState(false);
  // Transient flag: set on every count change, cleared by onAnimationEnd.
  // Self-throttles bursts (next change during active animation is a no-op
  // until the cycle completes) and avoids a stale class re-applying when
  // the chip remounts across the title-present / title-absent branches.
  const [isCountBumping, setIsCountBumping] = useState(false);
  const prevCountRef = useRef(notification.count ?? 0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current);
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (bumpFallbackRef.current) clearTimeout(bumpFallbackRef.current);
      if (mouseLeaveTimerRef.current) clearTimeout(mouseLeaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const next = notification.count ?? 0;
    if (next === prevCountRef.current) return;
    prevCountRef.current = next;
    setIsCountBusy(true);
    setIsCountBumping(true);
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    busyTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setIsCountBusy(false);
      busyTimerRef.current = null;
    }, DURATION_300);
    // 150ms badge-bump animation + 50ms buffer. Under prefers-reduced-motion
    // or data-reduce-animations, the CSS animation is suppressed and
    // `animationend` never fires — without this fallback, isCountBumping
    // would latch true and stale-class on the next chip remount.
    if (bumpFallbackRef.current) clearTimeout(bumpFallbackRef.current);
    bumpFallbackRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setIsCountBumping(false);
      bumpFallbackRef.current = null;
    }, DURATION_200);
  }, [notification.count]);

  useEffect(() => {
    const handle = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(handle);
  }, []);

  useEffect(() => {
    // Pure state flips — `document.hasFocus()` is stale inside blur handlers
    // in Chromium 148, so the event arrival itself is the signal.
    const handleBlur = (): void => {
      // Eagerly clear the in-flight dismiss timer — waiting for the React
      // re-render to run the effect cleanup leaves a window where a timer
      // expiring right at blur dismisses the toast unseen.
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      if (pausedSinceRef.current === null) pausedSinceRef.current = Date.now();
      setIsWindowBlurred(true);
    };
    const handleFocus = (): void => setIsWindowBlurred(false);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const restoreFocus = useCallback(() => {
    if (toastRef.current?.contains(document.activeElement)) {
      const prev = prevFocusRef.current;
      // Guard against the previously-focused element having been unmounted
      // (e.g. its panel was torn down while the toast was active). Calling
      // .focus() on a detached node is a silent no-op, so focus would land
      // on body — explicit guard keeps intent obvious.
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    }
  }, []);

  // Ref-mirror of dismissed state so re-entrant calls within the same tick
  // (e.g. two synchronous Escape dispatches before React flushes the store
  // update) short-circuit before firing notification.onDismiss twice.
  const dismissedRef = useRef(false);
  useEffect(() => {
    if (notification.dismissed) dismissedRef.current = true;
  }, [notification.dismissed]);

  const handleDismiss = useCallback(() => {
    // If the notification is already dismissed, this click came in during the
    // exit fade after an eviction (or a double-click race). Skip the
    // user-dismiss callback so eviction/reentrancy don't fire onDismiss.
    if (dismissedRef.current || notification.dismissed) return;
    dismissedRef.current = true;
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (spinnerTimerRef.current) {
      clearTimeout(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
    }
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
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

  // Escape dismisses the topmost active toast. Only the topmost toast (as
  // determined by the parent Toaster) registers a handler so a single
  // keypress dismisses one toast at a time, newest first. Open dialogs and
  // the command palette take precedence via their own dialog-backstop path
  // before the global escape stack is consulted.
  useEscapeStack(isTopmost && !notification.dismissed, handleDismiss);

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
    const hasActions = !!(notification.action || (notification.actions?.length ?? 0) > 0);
    const cap = hasActions
      ? duration * VISIBLE_DURATION_MULTIPLIER
      : Math.min(duration * VISIBLE_DURATION_MULTIPLIER, MAX_VISIBLE_DURATION_MS);
    // Credit accumulated paused time so the cap only consumes unattended time.
    const deadline = (notification.firstShownAt ?? Date.now()) + cap + pausedAccumRef.current;
    const delay = Math.min(duration, Math.max(0, deadline - Date.now()));
    dismissTimerRef.current = setTimeout(() => dismissRef.current(), delay);
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [
    notification.duration,
    notification.contentKey,
    notification.firstShownAt,
    isPaused,
    notification.action,
    notification.actions,
  ]);

  // The success confirmation dwells, then dismisses. It holds while the pointer
  // rests on the card, the window is blurred, or — after a keyboard activation —
  // focus stays inside. Focus only counts for the keyboard: Chromium focuses a
  // clicked button, so for a pointer activation focus-inside would pin the
  // toast open until the user clicked away.
  const holdsDwellOnFocus = isFocusInside && actionActivatedByKeyboard;
  useEffect(() => {
    if (actionStatus !== "success" || isHovered || isWindowBlurred || holdsDwellOnFocus) return;
    dwellTimerRef.current = setTimeout(() => {
      if (mountedRef.current) dismissRef.current();
    }, UI_ACTION_SUCCESS_DWELL_MS);
    return () => {
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
    };
  }, [actionStatus, isHovered, isWindowBlurred, holdsDwellOnFocus]);

  const accentClass = ACCENT_CLASS[notification.type] ?? "border-l-status-info";
  const countBadge =
    notification.count != null && Number.isFinite(notification.count) && notification.count > 1 ? (
      <CountBadge
        count={notification.count}
        isBumping={isCountBumping}
        onBumpEnd={() => setIsCountBumping(false)}
      />
    ) : null;
  const { Icon, className: iconClassName } =
    TYPE_ICON_CONFIG[notification.type] ?? DEFAULT_ICON_CONFIG;

  // Two-node split: the outer wrapper owns ALL transform/opacity motion (entry
  // slide, exit) and the interaction surface (ref, role,
  // handlers); the inner card keeps `backdrop-blur-xl`. Chromium 146 flickers
  // or drops the blur when a `transform` transition runs on the same node as
  // `backdrop-filter`, so the animated node must never carry the blur (lessons
  // #6192, #2574 — the blur ancestor also anchors the options dropdown's
  // containing block, which stays intact on the inner card).
  return (
    <div
      ref={toastRef}
      className={cn(
        // A global banner pushes the toolbar's drag band below this
        // column's top-14 origin, so toast controls land inside it — stamp the
        // toast, not the pointer-events-none column, which would hold a rect
        // over the title bar even with nothing showing (#12347).
        "app-no-drag",
        "pointer-events-auto relative w-full min-w-[240px] max-w-[360px]",
        "transition-[transform,opacity]",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={
        {
          transform: `translateX(${isVisible ? "0px" : "2rem"})`,
          transitionDuration: `${isVisible ? UI_ENTER_DURATION : UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        } as CSSProperties
      }
      onMouseEnter={() => {
        if (mouseLeaveTimerRef.current) {
          clearTimeout(mouseLeaveTimerRef.current);
          mouseLeaveTimerRef.current = null;
        }
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        if (mouseLeaveTimerRef.current) clearTimeout(mouseLeaveTimerRef.current);
        // 500ms grace before clearing the hover-pause absorbs small jitter
        // and brief crossings of inner chrome (Sonner default). Focus and
        // dropdown-open pauses are tracked separately and remain held.
        mouseLeaveTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setIsHovered(false);
          mouseLeaveTimerRef.current = null;
        }, 500);
      }}
      onFocus={(e) => {
        // Remember where focus came from on every entry, not at mount: the user
        // may have moved on from wherever they were when the toast appeared.
        const from = e.relatedTarget;
        if (from instanceof Element && !e.currentTarget.contains(from)) {
          prevFocusRef.current = from;
        }
        setIsFocusInside(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsFocusInside(false);
        }
      }}
      data-toast=""
    >
      <div
        className={cn(
          "flex w-full items-start gap-3",
          // The severity edge must follow `border`: cn() resolves conflicts
          // last-wins, and a later `border` erases a left width set before it.
          "rounded-[var(--radius-sm)] border border-tint/[0.08] border-l-[3px]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-text-primary",
          "shadow-[var(--theme-shadow-floating)]",
          "ring-1 ring-inset ring-tint/[0.05]",
          accentClass
        )}
      >
        <div className="min-w-0 flex-1">
          {/* The live region holds only what the toast says. Its controls sit
              outside it, so an announcement (and every re-announcement on a
              count or label change) reads the event, not a list of buttons. */}
          <div
            role={notification.type === "error" ? "alert" : "status"}
            aria-busy={isCountBusy || undefined}
            className="flex items-start gap-3"
          >
            <div className={cn("shrink-0 mt-0.5", iconClassName)}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 space-y-1 min-w-0 py-0.5">
              {notification.title ? (
                <h4 className="font-medium leading-tight tracking-tight text-xs text-text-primary flex items-start gap-1.5">
                  <span className="min-w-0 line-clamp-2">{notification.title}</span>
                  {countBadge}
                </h4>
              ) : null}
              <div className="flex items-start gap-1.5">
                {typeof notification.message !== "string" && notification.inboxMessage ? (
                  <>
                    <span className="sr-only">{notification.inboxMessage}</span>
                    <div
                      aria-hidden="true"
                      className="min-w-0 flex-1 text-xs text-text-secondary leading-snug break-words"
                    >
                      {notification.message}
                    </div>
                  </>
                ) : (
                  <div className="min-w-0 flex-1 text-xs text-text-secondary leading-snug break-words">
                    {notification.message}
                  </div>
                )}
                {!notification.title && countBadge}
              </div>
            </div>
          </div>
          {(() => {
            const actions = [
              ...(notification.actions ?? []),
              ...(notification.action ? [notification.action] : []),
            ];
            if (actions.length === 0) return null;

            const handleActionClick = (
              action: (typeof actions)[number],
              index: number,
              byKeyboard: boolean
            ) => {
              if (activeActionIndex !== null) return;
              setActionActivatedByKeyboard(byKeyboard);

              const result = action.onClick();

              if (!action.successLabel) {
                handleDismiss();
                return;
              }

              setActiveActionIndex(index);

              if (result instanceof Promise) {
                let settled = false;
                spinnerTimerRef.current = setTimeout(() => {
                  if (!settled && mountedRef.current) {
                    setActionStatus("loading");
                  }
                }, DURATION_150);

                result
                  .then(() => {
                    settled = true;
                    if (spinnerTimerRef.current) {
                      clearTimeout(spinnerTimerRef.current);
                      spinnerTimerRef.current = null;
                    }
                    if (!mountedRef.current) return;
                    if (dismissTimerRef.current) {
                      clearTimeout(dismissTimerRef.current);
                      dismissTimerRef.current = null;
                    }
                    setActionStatus("success");
                    const announcementText = notification.title
                      ? `${notification.title}: ${action.successLabel}`
                      : action.successLabel!;
                    useAnnouncerStore.getState().announce(announcementText, "polite");
                  })
                  .catch(() => {
                    settled = true;
                    if (spinnerTimerRef.current) {
                      clearTimeout(spinnerTimerRef.current);
                      spinnerTimerRef.current = null;
                    }
                    if (!mountedRef.current) return;
                    setActionStatus("idle");
                    setActiveActionIndex(null);
                  });
              } else {
                if (dismissTimerRef.current) {
                  clearTimeout(dismissTimerRef.current);
                  dismissTimerRef.current = null;
                }
                setActionStatus("success");
                const announcementText = notification.title
                  ? `${notification.title}: ${action.successLabel}`
                  : action.successLabel!;
                useAnnouncerStore.getState().announce(announcementText, "polite");
              }
            };

            const isSuccess = actionStatus === "success";
            const showLoading = actionStatus === "loading" && activeActionIndex !== null;

            return (
              <div
                className={cn(
                  // pl-7 aligns the row with the text column: the 16px icon
                  // plus the live region's 12px gap.
                  "mt-2 pl-7 flex flex-wrap gap-1.5",
                  isSuccess && "animate-action-row-bump"
                )}
              >
                {actions.map((action, index) => {
                  const isActive = activeActionIndex === index;
                  const isDimmed = activeActionIndex !== null && !isActive;
                  const variant = action.variant ?? "primary";

                  return (
                    <Button
                      key={action.label}
                      // Same mapping as the grid bar and inline banners: the
                      // recommended action is outlined, the alternative is
                      // ghost, and severity stays on the icon and edge.
                      variant={variant === "secondary" ? "ghost" : "outline"}
                      size="sm"
                      // Forced colours flatten outline and ghost to the same
                      // border; this hook restores the primary's heavier one.
                      data-notification-action={variant}
                      // Enter/Space activate a button with a synthetic click
                      // whose detail is 0; a pointer click counts presses.
                      onClick={(e) => handleActionClick(action, index, e.detail === 0)}
                      className={cn(isDimmed && "opacity-50 pointer-events-none")}
                      // aria-disabled, not disabled: Chromium drops focus from a
                      // control the moment it becomes disabled, stranding a
                      // keyboard user on <body> mid-action.
                      aria-disabled={activeActionIndex !== null || undefined}
                    >
                      {isActive && showLoading ? (
                        <span
                          data-testid="toast-action-spinner"
                          className="inline-flex items-center gap-1.5"
                        >
                          <Spinner size="xs" />
                          {action.label}
                        </span>
                      ) : isActive && isSuccess ? (
                        <span
                          data-testid="toast-action-checkmark"
                          className="inline-flex items-center gap-1"
                        >
                          <Check className="h-3 w-3" />
                          {action.successLabel}
                        </span>
                      ) : (
                        action.label
                      )}
                    </Button>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {(notification.context?.projectId || notification.context?.eventKind) &&
          (() => {
            const eventKind = notification.context?.eventKind;
            return (
              <DropdownMenu onOpenChange={(open) => setIsDropdownOpen(open)}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Notification options"
                    className="[&_svg]:size-3.5"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="z-[var(--z-toast-overlay)]"
                >
                  {isNotificationEventKind(eventKind) && (
                    <DropdownMenuItem
                      onSelect={() => {
                        const projectId = notification.context?.projectId;
                        if (!isNotificationEventKind(eventKind)) return;
                        handleDismiss();
                        void actionService.dispatch("project.silenceNotificationKind", {
                          kind: eventKind,
                          projectId,
                        });
                      }}
                    >
                      Silence {EVENT_KIND_LABEL[eventKind]}
                      {notification.context?.projectId && eventKind !== "uiFeedback"
                        ? " from this project"
                        : ""}
                    </DropdownMenuItem>
                  )}
                  {notification.context?.projectId && (
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
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleDismiss}
          aria-label="Dismiss notification"
          className="[&_svg]:size-3.5"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function OverflowPill({ count }: { count: number }) {
  const openNotificationCenter = useUIStore((s) => s.openNotificationCenter);
  const label = `${count} more in notification center`;
  return (
    <button
      type="button"
      onClick={openNotificationCenter}
      aria-label={label}
      data-testid="toast-overflow-pill"
      className={cn(
        "app-no-drag",
        "pointer-events-auto self-end",
        "inline-flex h-6 items-center gap-1 rounded-full",
        "bg-surface-panel/85 backdrop-blur-xl",
        "border border-tint/[0.08] ring-1 ring-inset ring-tint/[0.05]",
        "px-2.5 text-2xs font-medium leading-none tabular-nums",
        "text-text-secondary hover:text-text-primary",
        "shadow-[var(--theme-shadow-floating)]",
        "transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      )}
    >
      +{count} more
    </button>
  );
}

export function Toaster() {
  const notifications = useNotificationStore((state) => state.notifications);
  const evictedToInboxCount = useNotificationHistoryStore((s) => s.evictedToInboxCount);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const toastNotifications = notifications.filter(
    (notification) => notification.placement !== "grid-bar"
  );

  if (!mounted || (toastNotifications.length === 0 && evictedToInboxCount === 0)) return null;

  // Newest renders first (top of the visual stack). Only the topmost active
  // notification owns the Escape handler — the parent decides which one
  // because mount order doesn't track active/dismissed state. As soon as the
  // topmost dismisses, the next active notification picks up registration.
  const renderOrder = [...toastNotifications].reverse();
  const topmostActiveId = renderOrder.find((n) => !n.dismissed)?.id;

  return createPortal(
    <div
      role="region"
      aria-label="Notifications"
      className="fixed top-14 z-[var(--z-toast)] flex flex-col gap-2 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--right-obstruction-offset, 0px))" }}
    >
      {renderOrder.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          isTopmost={notification.id === topmostActiveId}
        />
      ))}
      {evictedToInboxCount > 0 && <OverflowPill count={evictedToInboxCount} />}
    </div>,
    document.body
  );
}
