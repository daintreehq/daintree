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

function Toast({
  notification,
  isTopmost,
  stackIndex,
}: {
  notification: Notification;
  isTopmost: boolean;
  stackIndex: number;
}) {
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
  const isPaused = isHovered || isFocusInside || isDropdownOpen || isWindowBlurred;
  // Blurred time doesn't count against the visible-duration cap — the cap
  // bounds *visible* time (see MAX_VISIBLE_DURATION_MS), and a toast in a
  // blurred window isn't visible. Without this credit, a blur outlasting the
  // cap would compute a 0ms delay on refocus and instant-dismiss the toast
  // the user came back for (e.g. a watch-priority toast born blurred).
  const blurredAccumRef = useRef(0);
  const blurredSinceRef = useRef<number | null>(
    typeof document !== "undefined" && !document.hasFocus() ? Date.now() : null
  );
  const toastRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(null);

  type ActionStatus = "idle" | "loading" | "success";
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [activeActionIndex, setActiveActionIndex] = useState<number | null>(null);
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

  useLayoutEffect(() => {
    prevFocusRef.current = document.activeElement;
  }, []);

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
      if (blurredSinceRef.current === null) blurredSinceRef.current = Date.now();
      setIsWindowBlurred(true);
    };
    const handleFocus = (): void => {
      if (blurredSinceRef.current !== null) {
        blurredAccumRef.current += Date.now() - blurredSinceRef.current;
        blurredSinceRef.current = null;
      }
      setIsWindowBlurred(false);
    };
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
    // Credit accumulated blurred time so the cap only consumes visible time.
    const deadline = (notification.firstShownAt ?? Date.now()) + cap + blurredAccumRef.current;
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

  const accentClass = ACCENT_CLASS[notification.type] ?? "border-l-status-info";
  const { Icon, className: iconClassName } =
    TYPE_ICON_CONFIG[notification.type] ?? DEFAULT_ICON_CONFIG;

  // Stack depth: frontmost (newest) toast is 0; background toasts lift up and
  // scale down per index to read as a coordinated pile. The parent passes
  // dismissed/exiting toasts index 0 so the remaining *live* toasts slide into
  // their compacted positions. Clamp at 2 as a defensive floor against a
  // transient over-cap from dismissed-state races (MAX_VISIBLE_TOASTS keeps the
  // live count at 3).
  const depth = Math.min(Math.max(stackIndex, 0), 2);

  // Freeze the exit position at the toast's last live depth. Without this, an
  // evicted *background* toast (e.g. index 2 when MAX_VISIBLE_TOASTS evicts the
  // oldest) would fall off the parent's visible-index map, receive index 0, and
  // animate from the back of the pile toward the front as it fades — a visible
  // forward lurch. Holding the last depth lets it fade out in place. Uses
  // state + useLayoutEffect rather than a render-time ref write so the React
  // Compiler can reason about the value; the extra render on depth change is
  // synchronous (pre-paint) so it never causes a frame of jank.
  const [frozenDepth, setFrozenDepth] = useState(depth);
  useLayoutEffect(() => {
    if (!notification.dismissed) setFrozenDepth(depth);
  }, [depth, notification.dismissed]);
  const renderDepth = notification.dismissed ? frozenDepth : depth;

  // Two-node split: the outer wrapper owns ALL transform/opacity motion (entry
  // slide, stack lift/scale, exit) and the interaction surface (ref, role,
  // handlers); the inner card keeps `backdrop-blur-xl`. Chromium 146 flickers
  // or drops the blur when a `transform` transition runs on the same node as
  // `backdrop-filter`, so the animated node must never carry the blur (lessons
  // #6192, #2574 — the blur ancestor also anchors the options dropdown's
  // containing block, which stays intact on the inner card).
  return (
    <div
      ref={toastRef}
      className={cn(
        "pointer-events-auto relative w-full min-w-[240px] max-w-[360px]",
        "transition-[transform,opacity]",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={
        {
          "--toast-index": renderDepth,
          transform: `translateX(${isVisible ? "0px" : "2rem"}) translateY(calc(var(--toast-index) * -10px)) scale(calc(1 - var(--toast-index) * 0.05))`,
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
      onFocus={() => setIsFocusInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsFocusInside(false);
        }
      }}
      role={notification.type === "error" ? "alert" : "status"}
      aria-busy={isCountBusy || undefined}
    >
      <div
        className={cn(
          "group flex w-full items-start gap-3",
          "rounded-[var(--radius-sm)] border-l-[3px] border border-tint/[0.08]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-text-primary",
          "shadow-[var(--theme-shadow-floating)]",
          "ring-1 ring-inset ring-tint/[0.05]",
          accentClass
        )}
      >
        <div className={cn("shrink-0 mt-0.5", iconClassName)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 space-y-1 min-w-0 py-0.5">
          {notification.title ? (
            <h4 className="font-medium leading-tight tracking-tight text-xs text-text-primary flex items-center gap-1.5">
              <span className="min-w-0 truncate">{notification.title}</span>
              {notification.count != null &&
                Number.isFinite(notification.count) &&
                notification.count > 1 && (
                  <span
                    data-testid="toast-coalesce-badge"
                    aria-label={formatNotificationCountAriaLabel(notification.count)}
                    className={cn(
                      "shrink-0 rounded-full bg-tint/10 px-1.5 py-0.5 text-3xs font-medium leading-none text-text-secondary tabular-nums min-w-[3.5ch] text-center",
                      isCountBumping && "animate-badge-bump"
                    )}
                    style={{ animationDuration: `${DURATION_150}ms` }}
                    onAnimationEnd={(e) => {
                      if (e.animationName === "badge-bump") setIsCountBumping(false);
                    }}
                  >
                    {formatNotificationCountGlyph(notification.count, "×")}
                  </span>
                )}
            </h4>
          ) : notification.count != null &&
            Number.isFinite(notification.count) &&
            notification.count > 1 ? (
            <div>
              <span
                data-testid="toast-coalesce-badge"
                aria-label={formatNotificationCountAriaLabel(notification.count)}
                className={cn(
                  "inline-block rounded-full bg-tint/10 px-1.5 py-0.5 text-3xs font-medium leading-none text-text-secondary tabular-nums min-w-[3.5ch] text-center",
                  isCountBumping && "animate-badge-bump"
                )}
                style={{ animationDuration: `${DURATION_150}ms` }}
                onAnimationEnd={(e) => {
                  if (e.animationName === "badge-bump") setIsCountBumping(false);
                }}
              >
                {formatNotificationCountGlyph(notification.count, "×")}
              </span>
            </div>
          ) : null}
          {typeof notification.message !== "string" && notification.inboxMessage ? (
            <>
              <span className="sr-only">{notification.inboxMessage}</span>
              <div
                aria-hidden="true"
                className="text-xs text-text-secondary leading-snug break-words"
              >
                {notification.message}
              </div>
            </>
          ) : (
            <div className="text-xs text-text-secondary leading-snug break-words">
              {notification.message}
            </div>
          )}
          {(() => {
            const actions = [
              ...(notification.actions ?? []),
              ...(notification.action ? [notification.action] : []),
            ];
            if (actions.length === 0) return null;

            const handleActionClick = (action: (typeof actions)[number], index: number) => {
              if (activeActionIndex !== null) return;

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
                    dwellTimerRef.current = setTimeout(() => {
                      if (mountedRef.current) dismissRef.current();
                    }, UI_ACTION_SUCCESS_DWELL_MS);
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
                dwellTimerRef.current = setTimeout(() => {
                  if (mountedRef.current) dismissRef.current();
                }, UI_ACTION_SUCCESS_DWELL_MS);
              }
            };

            const isSuccess = actionStatus === "success";
            const showLoading = actionStatus === "loading" && activeActionIndex !== null;

            return (
              <div
                className={cn(
                  "mt-1.5 flex flex-wrap gap-1.5",
                  isSuccess && "animate-action-row-bump"
                )}
              >
                {actions.map((action, index) => {
                  const isActive = activeActionIndex === index;
                  const isDimmed = activeActionIndex !== null && !isActive;
                  const variant = action.variant ?? "primary";

                  return (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => handleActionClick(action, index)}
                      className={cn(
                        "px-2.5 py-1 rounded-[var(--radius-xs)]",
                        "text-xs font-medium transition-colors",
                        variant === "secondary"
                          ? "text-text-secondary hover:text-text-primary hover:bg-tint/10"
                          : "bg-status-info/10 text-status-info hover:bg-status-info/20",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                        isDimmed && "opacity-50 pointer-events-none"
                      )}
                      disabled={activeActionIndex !== null}
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
                    </button>
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
                  <button
                    type="button"
                    aria-label="Notification options"
                    className={cn(
                      "shrink-0 rounded-[var(--radius-xs)]",
                      "h-6 w-6 flex items-center justify-center",
                      "text-daintree-text/40 transition-colors duration-150",
                      "hover:text-daintree-text/80 hover:bg-tint/10",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                      "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    )}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4}>
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

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss notification"
          className={cn(
            "shrink-0 rounded-[var(--radius-xs)]",
            "h-6 w-6 flex items-center justify-center",
            "text-daintree-text/40 transition-colors duration-150",
            "hover:text-daintree-text/80 hover:bg-tint/10",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
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
        "pointer-events-auto self-end",
        "inline-flex items-center gap-1 rounded-full",
        "bg-surface-panel/85 backdrop-blur-xl",
        "border border-tint/[0.08] ring-1 ring-inset ring-tint/[0.05]",
        "px-2.5 py-1 text-2xs font-medium leading-none tabular-nums",
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

  // Stack index counts only live (non-dismissed) toasts so an exiting toast
  // doesn't occupy a slot — the remaining toasts compact into 0,1,2 and slide
  // up smoothly instead of snapping when one leaves. Exiting toasts get index 0
  // (no lift/scale) for the duration of their fade-out.
  const visibleIndexById = new Map<string, number>();
  renderOrder.filter((n) => !n.dismissed).forEach((n, index) => visibleIndexById.set(n.id, index));

  return createPortal(
    <div
      role="region"
      aria-label="Notifications"
      className="fixed top-14 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--right-obstruction-offset, 0px))" }}
    >
      {renderOrder.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          isTopmost={notification.id === topmostActiveId}
          stackIndex={visibleIndexById.get(notification.id) ?? 0}
        />
      ))}
      {evictedToInboxCount > 0 && <OverflowPill count={evictedToInboxCount} />}
    </div>,
    document.body
  );
}
