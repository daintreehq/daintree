import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useId,
  createContext,
  useContext,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { getVisibleTabbableElements } from "@/lib/accessibility";
import { logError } from "@/utils/logger";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { useOverlayState, useEscapeStack } from "@/hooks";
import {
  registerDialogEscapeBackstop,
  isTopmostDialogBackstop,
  radixLayerWasOpenWhenEscapePressed,
  escapeWasYieldedToDialog,
  markBackstopConsumedEscape,
  ESCAPE_BACKSTOP_DIALOG_ATTR,
} from "@/lib/dialogEscapeBackstop";
import { APP_DIALOG_SURFACE_ATTR } from "@/lib/appDialogSurface";
import { useDockPopoverOpen } from "@/lib/dockPopoverLayer";
import { usePortalStore } from "@/store";
import { clearDialogOverlays } from "@/lib/dialogOverlayDismissal";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { DialogDismissSurface } from "./DialogDismissSurface";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_SCRIM_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import {
  SurfaceHeader,
  SurfaceHeaderTitle,
  SurfaceHeaderCloseButton,
} from "@/components/ui/SurfaceHeader";
import { Button } from "./button";

type DialogSize = "sm" | "md" | "lg" | "4xl" | "5xl" | "6xl" | "7xl" | "workspace";
type DialogVariant = "default" | "destructive" | "info";
type DialogZIndex = "modal" | "nested";
type DialogInitialFocus = "first" | "cancel" | "confirm" | "none";

/**
 * A caller-supplied "logical successor" to receive focus when the dialog's
 * trigger has been unmounted before close. Either a ref to a stable element or
 * a function resolving the target at restoration time (for targets whose
 * identity changes while the dialog is open, e.g. the next row after a delete).
 */
type RestoreFocusTarget = React.RefObject<HTMLElement | null> | (() => HTMLElement | null);

/**
 * Resolve a {@link RestoreFocusTarget} to an element. Tolerates a throwing
 * resolver so the caller can still fall through to the app-shell fallback.
 */
function resolveRestoreFocusTarget(target: RestoreFocusTarget | undefined): HTMLElement | null {
  if (!target) return null;
  try {
    const resolved = typeof target === "function" ? target() : target.current;
    return resolved instanceof HTMLElement ? resolved : null;
  } catch {
    return null;
  }
}

interface AppDialogContextValue {
  onClose: () => void;
  titleId: string;
  descriptionId: string;
  variant: DialogVariant;
}

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

export interface AppDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onBeforeClose?: () => boolean | Promise<boolean>;
  size?: DialogSize;
  variant?: DialogVariant;
  /**
   * When true, switches a destructive dialog from `role="alertdialog"` to
   * `role="dialog"`. Required for dialogs that contain scrollable preview
   * content (commit lists, directory tables) — WAI-ARIA APG mandates
   * `alertdialog` only for brief text-only messages.
   */
  hasPreview?: boolean;
  dismissible?: boolean;
  children: React.ReactNode;
  className?: string;
  maxHeight?: string;
  zIndex?: DialogZIndex;
  initialFocus?: DialogInitialFocus;
  restoreFocusTo?: RestoreFocusTarget;
  "data-testid"?: string;
}

export type { DialogSize, DialogVariant, DialogZIndex, DialogInitialFocus, RestoreFocusTarget };

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-2xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-[min(96rem,92vw)]",
  // App-scale surfaces (diff review workspace): near-full-window canvas.
  workspace: "max-w-[min(110rem,95vw)]",
};

export function AppDialog({
  isOpen,
  onClose,
  onBeforeClose,
  size = "md",
  variant = "default",
  hasPreview = false,
  dismissible = true,
  children,
  className,
  maxHeight = "max-h-[80vh]",
  zIndex = "modal",
  initialFocus,
  restoreFocusTo,
  "data-testid": dataTestId,
}: AppDialogProps) {
  // A dock popover renders above the standard modal tier, so a dialog opened
  // while one is up — from a docked terminal or anywhere else — would paint
  // underneath it while still trapping focus (#11505). Resolved here rather
  // than at each call site: the set of dialogs reachable from a docked panel is
  // large, indirect, and grows, and every one of them wants the same answer.
  const dockPopoverOpen = useDockPopoverOpen();
  const effectiveZIndex: DialogZIndex = dockPopoverOpen ? "nested" : zIndex;

  const effectiveInitialFocus: DialogInitialFocus =
    initialFocus ?? (variant === "destructive" ? "cancel" : "first");
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const backdropPointerRef = useRef<number | null>(null);
  // State, not a ref: `DialogDismissSurface` has to re-render once the node
  // exists, and a ref would leave it registering `null` forever.
  const [backdropNode, setBackdropNode] = useState<HTMLDivElement | null>(null);
  const closeInFlightRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const { isOpen: portalOpen, width: portalWidth } = usePortalStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );
  const portalOffset = portalOpen ? portalWidth : 0;

  // Hold the latest `restoreFocusTo` in a ref so `restoreFocus` stays
  // identity-stable. It feeds the unmount-cleanup effect's dep array; if it
  // changed identity (e.g. a caller passing an inline function), the cleanup
  // would fire mid-open and restore focus prematurely.
  const restoreFocusToRef = useRef(restoreFocusTo);
  useEffect(() => {
    restoreFocusToRef.current = restoreFocusTo;
  }, [restoreFocusTo]);

  const restoreFocus = useCallback(() => {
    const el = previousActiveElement.current;
    previousActiveElement.current = null;
    if (!el) return;
    // Re-arm the tooltip focus-open suppression right before the focus
    // move: focusing a tooltip trigger re-opens its tooltip synchronously
    // through Radix's focus path, and this runs an exit animation after
    // the close-transition clear already fired (issue #11030).
    clearDialogOverlays();
    if (document.contains(el)) {
      el.focus();
      return;
    }
    // Trigger was unmounted before close. Prefer a caller-supplied logical
    // successor (e.g. the next row after a delete) when one is still connected
    // and actually accepts focus.
    const target = resolveRestoreFocusTarget(restoreFocusToRef.current);
    if (target?.isConnected) {
      target.focus();
      if (document.activeElement === target) return;
    }
    // Otherwise hand focus to the first tabbable child of the app shell rather
    // than letting it silently fall to <body>.
    const root = document.getElementById("root");
    const fallback = root ? getVisibleTabbableElements(root)[0] : undefined;
    fallback?.focus();
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    animationDuration: getUiTransitionDuration("exit"),
    onAnimateOut: restoreFocus,
  });

  useOverlayState(isOpen || shouldRender);

  // Clear stranded tooltips and shortcut hints on every open and close
  // transition (issue #11030): on open before the RAF-deferred autofocus
  // below fires, on close before the exit animation finishes. Transition-
  // guarded because most dialogs stay mounted with isOpen=false — a bare
  // effect would dismiss unrelated tooltips whenever one mounts.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen === wasOpenRef.current) return;
    wasOpenRef.current = isOpen;
    clearDialogOverlays();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      if (effectiveInitialFocus === "none") return;
      requestAnimationFrame(() => {
        const root = dialogRef.current;
        if (!root) return;
        let target: HTMLElement | null = null;
        if (effectiveInitialFocus === "cancel" || effectiveInitialFocus === "confirm") {
          target = root.querySelector<HTMLElement>(
            `[data-confirm-role="${effectiveInitialFocus}"]`
          );
        }
        if (!target) {
          target = getVisibleTabbableElements(root)[0] ?? null;
        }
        if (target) {
          target.focus();
        } else {
          root.focus();
        }
      });
    }
  }, [isOpen, effectiveInitialFocus, restoreFocus]);

  useEffect(() => {
    return () => {
      restoreFocus();
    };
  }, [restoreFocus]);

  const handleClose = useCallback(async () => {
    if (!dismissible || closeInFlightRef.current) return;
    if (!onBeforeClose) {
      onClose();
      return;
    }

    closeInFlightRef.current = true;
    try {
      const canClose = await onBeforeClose();
      if (canClose) onClose();
    } catch (error) {
      logError("AppDialog onBeforeClose failed", error);
    } finally {
      closeInFlightRef.current = false;
    }
  }, [dismissible, onBeforeClose, onClose]);

  useEscapeStack(isOpen, handleClose);

  // Backstop Escape handler on document bubble.
  //
  // The bubble-phase escape stack dispatcher (`useGlobalEscapeDispatcher`)
  // bails when `defaultPrevented` is true. Radix DismissableLayers
  // (tooltips, popovers) register Escape handling on document with
  // capture and call `preventDefault()` when they're the highest
  // layer — including while they're mid-exit (data-state="closed" but
  // still mounted by Presence). That preempts the dispatcher and
  // leaves the dialog stuck open.
  //
  // This handler runs on document bubble (after target handlers like
  // a search input clearing its query) and ignores defaultPrevented,
  // so the dialog still closes. Inner handlers can opt out by calling
  // `e.stopPropagation()` — which the settings search input already
  // does when clearing a non-empty query.
  // Backstop registration must NOT churn on every handleClose-identity change
  // (re-registering pushes the entry to the top of the stack and breaks LIFO
  // when this dialog is rendered underneath another). Hold the latest closer
  // in a ref and only register once per `isOpen && dismissible` cycle.
  const handleCloseRef = useRef(handleClose);
  useEffect(() => {
    handleCloseRef.current = handleClose;
  }, [handleClose]);

  useEffect(() => {
    if (!isOpen || !dismissible) return;
    const closeThis = () => {
      void handleCloseRef.current();
    };
    const unregister = registerDialogEscapeBackstop(closeThis);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.repeat) return;
      // Only fire for the topmost dialog so layered overlays close one
      // at a time (LIFO), matching the escape-stack semantics.
      if (!isTopmostDialogBackstop(closeThis)) return;
      // If a Radix popover / select / dropdown was OPEN when Escape entered
      // the event chain, it is the one handling this keypress — bail so the
      // dialog underneath stays open. The backstop exists only for the
      // mid-exit case where Radix's stale `preventDefault` would otherwise
      // leave the dialog stuck.
      // …unless that layer explicitly declined this keypress because focus sits
      // in a dialog above it — a dock popover deliberately stays open behind the
      // dialog it spawned, so it is always "the open layer" (#11505).
      if (radixLayerWasOpenWhenEscapePressed() && !escapeWasYieldedToDialog(e)) return;
      // We deliberately do NOT bail on `e.defaultPrevented`: Radix Select /
      // Combobox triggers call `preventDefault` on Escape even when their
      // popup is closed, which would leave the dialog stuck open if we
      // honored that flag. The capture-time radix-open snapshot above is
      // the correct gate.
      //
      // Mark the event consumed so the window-level escape-stack
      // dispatcher (`useGlobalEscapeDispatcher`) bails — otherwise, after
      // `closeThis` synchronously unregisters the top entry, the dispatcher
      // walks one layer deeper and closes the dialog underneath.
      markBackstopConsumedEscape();
      closeThis();
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      unregister();
    };
  }, [isOpen, dismissible]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Tab" && dialogRef.current) {
      // Don't interfere if another modal (e.g., a nested dialog portal) has focus
      const activeEl = document.activeElement;
      if (activeEl) {
        const closestModal = activeEl.closest('[aria-modal="true"]');
        if (closestModal && !closestModal.contains(dialogRef.current)) return;
      }

      const focusable = getVisibleTabbableElements(dialogRef.current);

      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  const resetBackdropPointer = useCallback(() => {
    backdropPointerRef.current = null;
  }, []);

  const handleBackdropPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.button === 0) {
      backdropPointerRef.current = e.pointerId;
      return;
    }
    backdropPointerRef.current = null;
  }, []);

  const handleBackdropPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && backdropPointerRef.current === e.pointerId) {
        void handleClose();
      }
      resetBackdropPointer();
    },
    [handleClose, resetBackdropPointer]
  );

  if (!shouldRender) return null;

  return createPortal(
    <AppDialogContext.Provider value={{ onClose: handleClose, titleId, descriptionId, variant }}>
      <div
        className={cn(
          "fixed inset-0 flex items-center justify-center bg-scrim-medium backdrop-blur-[var(--theme-scrim-blur)] backdrop-saturate-[var(--theme-material-saturation)]",
          effectiveZIndex === "nested" ? "z-[var(--z-nested-dialog)]" : "z-[var(--z-modal)]",
          // Opacity-only, so reduced motion leaves it alone: a scrim fade is not
          // spatial motion. WCAG 2.3.3.
          "transition-opacity",
          isVisible ? "opacity-100" : "opacity-0"
        )}
        style={{
          right: portalOffset,
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
          transitionTimingFunction: UI_SCRIM_EASING,
        }}
        ref={setBackdropNode}
        onPointerDown={handleBackdropPointerDown}
        onPointerUp={handleBackdropPointerUp}
        onPointerCancel={resetBackdropPointer}
        role={variant === "destructive" && !hasPreview ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        // Marks the surface as one a Radix layer underneath can hand Escape to
        // — see `ESCAPE_BACKSTOP_DIALOG_ATTR`. Tracks the backstop registration
        // (`isOpen && dismissible`), not merely being mounted: a dialog mid-exit
        // has already unregistered and could not take the keypress.
        {...(isOpen && dismissible ? { [ESCAPE_BACKSTOP_DIALOG_ATTR]: "" } : {})}
        // Unconditional, unlike the Escape backstop above: `handleDockInteractOutside`
        // needs to recognise this surface whether or not the dialog is dismissible.
        {...{ [APP_DIALOG_SURFACE_ATTR]: "" }}
        data-testid={dataTestId}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          className={cn(
            "bg-surface-dialog border border-border-default rounded-[var(--radius-xl)] shadow-[var(--theme-shadow-dialog)] mx-4 flex flex-col overflow-hidden",
            maxHeight,
            sizeClasses[size],
            "w-full",
            // Tailwind v4 translate-*/scale-* emit the individual `translate`
            // and `scale` properties, which `transform` in a transition list
            // does NOT cover — list them explicitly or the rise/zoom snaps.
            "transition-[opacity,translate,scale]",
            // Reduced motion keeps the fade and drops only the rise/zoom: opacity
            // is not vestibular, movement is. WCAG 2.3.3.
            "motion-reduce:transition-opacity motion-reduce:translate-none motion-reduce:scale-none",
            isVisible
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 translate-y-1 scale-[0.98]",
            "outline-hidden",
            className
          )}
          style={
            {
              transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
              transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
              "--scroll-shadow-color": "var(--color-surface-dialog)",
            } as CSSProperties
          }
          onClick={(e) => e.stopPropagation()}
        >
          {children}
          {/* A click anywhere on this surface dismisses a popover the dialog
              hosts — see `DialogDismissSurface`. Registered on the backdrop so
              the scrim counts too. */}
          <DialogDismissSurface node={backdropNode} />
          {/* Co-located live region: VoiceOver suppresses announcements made
              from `aria-live` regions outside the focused `aria-modal` subtree
              when `document.ariaNotify` is unavailable (Chromium 354736464). */}
          <AccessibilityAnnouncer />
        </div>
      </div>
    </AppDialogContext.Provider>,
    document.body
  );
}

interface AppDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
  /** This dialog pads its own body rather than using `AppDialog.Body` — see {@link CHROME_INSET}. */
  plainBody?: boolean;
}

/**
 * Header and footer sit outside the body's scroll box, so a bare `px-6` leaves
 * them 11px short of it: `AppDialog.Body` reserves a scrollbar gutter on both
 * edges, which pushes every field in the form that much further in. Padding the
 * chrome by the same gutter puts the title, the fields and the buttons on one
 * column instead of three that nearly agree.
 *
 * The 11px is the same figure `AppDialog.Body` reserves — `scrollbar-width:
 * thin` in `index.css`. It has to be a literal: Tailwind only sees class names
 * it can find in the source, so this cannot be built from a shared constant.
 *
 * Dialogs that pad their own body instead (`AppDialog.BodyScroll`, a custom
 * scroller) have no gutter to line up with and pass `plainBody` — for them this
 * inset would be the misalignment rather than the fix.
 */
const CHROME_INSET = "px-[calc(1.5rem+11px)]";
const PLAIN_INSET = "px-6";

AppDialog.Header = function AppDialogHeader({
  children,
  className,
  plainBody,
}: AppDialogHeaderProps) {
  // `density` is deliberately not forwarded: every dialog header is comfortable,
  // and exposing it would widen AppDialog's public surface for no caller.
  return (
    <SurfaceHeader className={cn(plainBody ? PLAIN_INSET : CHROME_INSET, className)}>
      {children}
    </SurfaceHeader>
  );
};

interface AppDialogTitleProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  as?: "h2" | "h3";
}

AppDialog.Title = function AppDialogTitle({ children, icon, className, as }: AppDialogTitleProps) {
  const context = useContext(AppDialogContext);
  return (
    <SurfaceHeaderTitle as={as} id={context?.titleId} icon={icon} className={className}>
      {children}
    </SurfaceHeaderTitle>
  );
};

interface AppDialogCloseButtonProps {
  className?: string;
  "aria-label"?: string;
}

AppDialog.CloseButton = function AppDialogCloseButton({
  className,
  "aria-label": ariaLabel = "Close dialog",
}: AppDialogCloseButtonProps) {
  const context = useContext(AppDialogContext);
  return (
    <SurfaceHeaderCloseButton
      onClick={context?.onClose}
      className={className}
      aria-label={ariaLabel}
    />
  );
};

interface AppDialogBodyProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Scrolls the body back to the top whenever this value changes. For a
   * queue-driven singleton dialog, one request is promoted into the same
   * mounted dialog as the last one resolves — so without this the next request
   * opens at the previous request's scroll offset, showing a freshly promoted
   * tool's body already scrolled past the part that identifies it. Keying the
   * caller's own content resets that content's state but not this scroller,
   * which is the element that actually holds the offset.
   *
   * Omit it and nothing changes.
   */
  resetScrollKey?: string | number;
}

AppDialog.Body = function AppDialogBody({
  children,
  className,
  resetScrollKey,
}: AppDialogBodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Layout effect, not passive: the reset has to land before paint, or the
  // promoted request is briefly visible at the old offset.
  useLayoutEffect(() => {
    if (resetScrollKey === undefined) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [resetScrollKey]);

  return (
    // `className` belongs on the padded scroll box, not on ScrollShadow's outer
    // wrapper — the wrapper's children are the two absolute edge overlays plus
    // the scroll box, so a caller's `space-y-*` there styled the overlays and
    // hung a stray margin off the scroll box while the actual fields got no
    // spacing at all. Matches where `BodyScroll` puts it.
    //
    // The gutter is reserved, and on both edges. The app's scrollbar is 11px of
    // real layout (`scrollbar-width: thin` in `index.css`, which outranks the
    // 6px `::-webkit-scrollbar` rule), so without this every control in a
    // dialog resizes by 11px the moment its body crosses the overflow
    // threshold — a hint row appearing, a validation banner clearing, a form
    // swapping sections. `both-edges` keeps the padding symmetric; reserving
    // one side only trades a jump for a permanent lopsided inset.
    <ScrollShadow
      ref={scrollRef}
      className="flex-1 min-h-0"
      scrollClassName={cn("p-6 [scrollbar-gutter:stable_both-edges]", className)}
    >
      {children}
    </ScrollShadow>
  );
};

interface AppDialogBodyScrollProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.BodyScroll = function AppDialogBodyScroll({
  children,
  className,
}: AppDialogBodyScrollProps) {
  // Deliberately NOT carrying `Body`'s reserved gutter. This variant is the
  // escape hatch for callers that own their own scrolling and padding, and
  // `scrollbar-gutter` reserves its space on an `overflow: hidden` box too — so
  // it would put 22px of dead inset inside `PanelDialogHost`'s edge-to-edge
  // panel host, which sets `overflow-hidden p-0` precisely to fill the dialog.
  return <div className={cn("flex-1 overflow-auto min-h-0 p-6", className)}>{children}</div>;
};

export interface DialogAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  intent?: "default" | "destructive";
}

interface AppDialogFooterProps {
  children?: React.ReactNode;
  className?: string;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
  hint?: React.ReactNode;
  /** This dialog pads its own body rather than using `AppDialog.Body` — see {@link CHROME_INSET}. */
  plainBody?: boolean;
}

AppDialog.Footer = function AppDialogFooter({
  children,
  className,
  primaryAction,
  secondaryAction,
  hint,
  plainBody,
}: AppDialogFooterProps) {
  const context = useContext(AppDialogContext);
  const dialogVariant = context?.variant ?? "default";

  // The standard dialog primary action is the high-contrast neutral button, not the
  // accent fill: its fill is the theme's own body-text colour, so it resolves near-white
  // on dark themes and near-black on light ones and stays legible whatever the accent is
  // (a bright accent made the old CTA label hard to read). `intent` stays a semantic
  // danger flag — destructive wins first and is unaffected.
  const getPrimaryVariant = () => {
    if (primaryAction?.intent === "destructive" || dialogVariant === "destructive") {
      return "destructive";
    }
    return "contrast";
  };

  return (
    <div
      className={cn(
        plainBody ? PLAIN_INSET : CHROME_INSET,
        "py-4 border-t border-border-strong bg-surface-panel flex items-center gap-3 shrink-0",
        hint ? "justify-between" : "justify-end",
        className
      )}
    >
      {/* min-w-0 so a long hint can shrink and truncate rather than squeezing the
          action row: as a flex child its default min-width:auto floor is its own
          content, so without this it pushes the buttons past the card edge and
          the primary label gets clipped. The actions never yield — a hint is
          explanatory, an action is how the dialog is answered. flex-1 pins the
          hint's width to the dialog rather than to its own text, which is what
          lets a hint measure its own box and crop to it. */}
      {hint && (
        <div
          className="text-[12px] text-daintree-text/55 flex min-w-0 flex-1 items-center gap-1"
          data-testid="app-dialog-hint"
        >
          {hint}
        </div>
      )}
      {children}
      {!children && (
        <div className="flex shrink-0 items-center gap-3">
          {secondaryAction && (
            <Button
              variant="ghost"
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
              className="text-daintree-text/70 hover:text-daintree-text"
              data-confirm-role="cancel"
            >
              {secondaryAction.label}
            </Button>
          )}
          {primaryAction && (
            <Button
              variant={getPrimaryVariant()}
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              loading={primaryAction.loading}
              data-confirm-role="confirm"
            >
              {primaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

interface AppDialogDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.Description = function AppDialogDescription({
  children,
  className,
}: AppDialogDescriptionProps) {
  const context = useContext(AppDialogContext);
  return (
    <p id={context?.descriptionId} className={cn("text-sm text-daintree-text/70", className)}>
      {children}
    </p>
  );
};
