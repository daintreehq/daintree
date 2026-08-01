import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { KBD_CLASS, KbdChord } from "@/components/ui/Kbd";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { useOverlayState, useEscapeStack } from "@/hooks";
import {
  registerDialogEscapeBackstop,
  isTopmostDialogBackstop,
  radixLayerWasOpenWhenEscapePressed,
  markBackstopConsumedEscape,
} from "@/lib/dialogEscapeBackstop";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { clearDialogOverlays } from "@/lib/dialogOverlayDismissal";
import { usePaletteStore } from "@/store/paletteStore";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_SCRIM_EASING,
  UI_PALETTE_STALE_DELAY,
  getUiPaletteTransitionDuration,
} from "@/lib/animationUtils";

export { KBD_CLASS };

export interface AppPaletteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  ariaLabel: string;
  className?: string;
}

export function AppPaletteDialog({
  isOpen,
  onClose,
  children,
  ariaLabel,
  className,
}: AppPaletteDialogProps) {
  useEscapeStack(isOpen, onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const restoreFocus = useCallback(() => {
    const el = previousFocusRef.current;
    previousFocusRef.current = null;
    if (!el) return;
    // Palette-to-palette handoff: the next palette will install its
    // own focus, so skip restore entirely — and skip the overlay clear
    // below, which would wipe overlays the incoming palette owns.
    if (usePaletteStore.getState().activePaletteId) return;
    // Re-arm the tooltip focus-open suppression right before the focus
    // move: focusing a tooltip trigger re-opens its tooltip synchronously
    // through Radix's focus path, and this runs an exit animation after
    // the close-transition clear already fired (issue #11030).
    clearDialogOverlays();
    if (document.contains(el)) {
      el.focus();
      return;
    }
    const root = document.getElementById("root");
    root?.querySelector<HTMLElement>(TABBABLE_SELECTOR)?.focus();
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    animationDuration: getUiPaletteTransitionDuration("exit"),
    onAnimateOut: restoreFocus,
  });

  useOverlayState(isOpen || shouldRender);

  // Clear stranded tooltips and shortcut hints on every open and close
  // transition (issue #11030): on open before the RAF-deferred autofocus
  // below fires, on close before the exit animation finishes. Transition-
  // guarded because palettes stay mounted with isOpen=false — a bare
  // effect would dismiss unrelated tooltips whenever one mounts.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen === wasOpenRef.current) return;
    wasOpenRef.current = isOpen;
    clearDialogOverlays();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const el = document.activeElement;
      if (el instanceof HTMLElement) previousFocusRef.current = el;
      requestAnimationFrame(() => {
        const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(TABBABLE_SELECTOR);
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          dialogRef.current?.focus();
        }
      });
    }
  }, [isOpen]);

  // If the host of an open palette unmounts before the exit animation
  // finishes, useAnimatedPresence's cleanup deliberately does NOT call
  // onAnimateOut — so this is the only place restoreFocus runs in that
  // path. Mirrors the cleanup AppDialog already has.
  useEffect(() => {
    return () => {
      restoreFocus();
    };
  }, [restoreFocus]);

  // Backstop Escape on document bubble. The bubble-phase escape
  // stack dispatcher (`useGlobalEscapeDispatcher`) bails when
  // `defaultPrevented` is true, which Radix DismissableLayers
  // (tooltips, popovers) set in capture phase even mid-exit.
  // Document-bubble fires after target handlers but ignores
  // defaultPrevented; inner handlers can still opt out by calling
  // `e.stopPropagation()`.
  // Backstop registration must NOT churn on every onClose-identity change
  // (re-registering pushes the entry to the top of the stack and breaks LIFO
  // when this palette is rendered underneath another dialog). Hold the latest
  // onClose in a ref and only register once per `isOpen` cycle.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const closeThis = () => onCloseRef.current();
    const unregister = registerDialogEscapeBackstop(closeThis);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.repeat) return;
      // Only fire for the topmost dialog so layered overlays close one
      // at a time (LIFO), matching the escape-stack semantics.
      if (!isTopmostDialogBackstop(closeThis)) return;
      // If a Radix popover / select / dropdown was OPEN when Escape entered
      // the event chain, it is the one handling this keypress — bail so the
      // palette underneath stays open. The backstop exists only for the
      // mid-exit case where Radix's stale `preventDefault` would otherwise
      // leave the palette stuck.
      if (radixLayerWasOpenWhenEscapePressed()) return;
      // We deliberately do NOT bail on `e.defaultPrevented`: Radix Select /
      // Combobox triggers call `preventDefault` on Escape even when their
      // popup is closed, which would leave the palette stuck. The
      // capture-time radix-open snapshot above is the correct gate.
      //
      // Mark the event consumed so the window-level escape-stack
      // dispatcher (`useGlobalEscapeDispatcher`) bails.
      markBackstopConsumedEscape();
      closeThis();
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      unregister();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        const focusableElements =
          dialogRef.current.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
        const firstEl = focusableElements[0];
        const lastEl = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl?.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!shouldRender) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-scrim-medium backdrop-blur-[var(--theme-scrim-blur-palette)] backdrop-saturate-[var(--theme-material-saturation)]",
        // Opacity-only, so reduced motion leaves it alone: a scrim fade is not
        // spatial motion. WCAG 2.3.3.
        "transition-opacity",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={{
        transitionDuration: isVisible
          ? `${UI_PALETTE_ENTER_DURATION}ms`
          : `${UI_PALETTE_EXIT_DURATION}ms`,
        transitionTimingFunction: UI_SCRIM_EASING,
      }}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={isOpen ? "true" : "false"}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "w-full max-w-xl mx-4 bg-surface-dialog border border-border-default rounded-[var(--radius-xl)] shadow-[var(--theme-shadow-dialog)] overflow-hidden origin-top",
          // Tailwind v4 scale-* emits the individual `scale` property, which
          // `transform` in a transition list does NOT cover — the palette
          // zoom only animates when `scale` is listed explicitly.
          "transition-[opacity,scale]",
          "motion-reduce:transition-opacity motion-reduce:scale-100",
          isVisible ? "opacity-100 scale-100" : "opacity-0 scale-[0.96]",
          className
        )}
        style={
          {
            transitionDuration: isVisible
              ? `${UI_PALETTE_ENTER_DURATION}ms`
              : `${UI_PALETTE_EXIT_DURATION}ms`,
            transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
            "--scroll-shadow-color": "var(--color-surface-dialog)",
          } as CSSProperties
        }
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        {/* Co-located live region: VoiceOver suppresses announcements made
            from `aria-live` regions outside the focused `aria-modal` subtree
            when `document.ariaNotify` is unavailable (Chromium 354736464). */}
        <AccessibilityAnnouncer />
      </div>
    </div>,
    document.body
  );
}

interface AppPaletteHeaderProps {
  label: string;
  /** Canonical shortcut string rendered via KbdChord (e.g. "Cmd+N"). */
  shortcut?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Show an indeterminate loading bar pinned to the bottom of the header.
   * The bar fades in after the 200ms palette stale-delay gate
   * (`UI_PALETTE_STALE_DELAY`), so fast loads never flash a sweep.
   */
  isLoading?: boolean;
}

AppPaletteDialog.Header = function AppPaletteHeader({
  label,
  shortcut,
  children,
  className,
  isLoading = false,
}: AppPaletteHeaderProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden px-3 pt-2 pb-1 border-b border-border-strong",
        className
      )}
    >
      <div className="flex justify-between items-center mb-1.5 text-[11px] text-daintree-text/50">
        <span>{label}</span>
        {shortcut ? <KbdChord shortcut={shortcut} /> : null}
      </div>
      {children}
      <div
        aria-hidden="true"
        className="palette-loading-bar transition-opacity motion-reduce:transition-none"
        data-loading={isLoading ? "true" : "false"}
        style={{
          opacity: isLoading ? 1 : 0,
          transitionDuration: isLoading
            ? `${UI_PALETTE_ENTER_DURATION}ms`
            : `${UI_PALETTE_EXIT_DURATION}ms`,
          transitionDelay: isLoading ? `${UI_PALETTE_STALE_DELAY}ms` : "0ms",
        }}
      >
        <div className="palette-loading-bar__sweep" />
      </div>
    </div>
  );
};

/**
 * Keys the body forwards to the owning palette's keydown handler when the
 * scroll container itself holds focus. Tab and Shift+Tab are deliberately
 * absent: the container is a real tab stop (see `tabIndex` below) and palettes
 * such as the project switcher render controls after it that must stay
 * reachable by native traversal. PageUp/PageDown/Space are left to the
 * browser so the region keeps its native scrolling.
 */
const BODY_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  // Horizontal arrows carry the disclosure half of the tree pattern for palettes
  // whose list has collapsible groups (`PilotView`). Withholding them left the
  // region able to move between rows but not in or out of a group, which is
  // half a keyboard. Flat-list palettes have no case for them and ignore them,
  // uncancelled, exactly as they did before.
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  // Palettes bind modified Backspace to a row action (the project switcher
  // advertises ⌘⌫ to close a project). Forwarding it keeps the footer hint
  // honest once focus is on the region; palettes that ignore the key are
  // unaffected, and unmodified Backspace still falls through untouched.
  "Backspace",
]);

interface AppPaletteBodyProps {
  children: React.ReactNode;
  className?: string;
  maxHeight?: string;
  /** Accessible name for the focusable results region. */
  ariaLabel: string;
  /**
   * The same active-descendant IDREF the query input carries. Mirrored here so
   * the active option keeps being announced once focus moves off the input —
   * only the element holding DOM focus acts as the active-descendant owner, so
   * carrying it on both is not a double-announcement.
   */
  activeDescendant?: string;
  /**
   * The palette's input keydown handler. Required rather than optional so a new
   * consumer cannot silently reintroduce the dead-end scroll region that made
   * arrow and Enter navigation stop working after Tab (#11431).
   */
  onNavigationKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
}

AppPaletteDialog.Body = function AppPaletteBody({
  children,
  className,
  maxHeight = "max-h-[50vh]",
  ariaLabel,
  activeDescendant,
  onNavigationKeyDown,
}: AppPaletteBodyProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only when the scroller itself owns focus. Palette bodies also host
      // their own controls (the project switcher's scratch section), and Enter
      // on one of those must activate the button, not confirm a result.
      if (e.target !== e.currentTarget) return;
      if (!BODY_NAVIGATION_KEYS.has(e.key)) return;
      onNavigationKeyDown(e);
    },
    [onNavigationKeyDown]
  );

  return (
    <ScrollShadow
      // Load-bearing for axe's `scrollable-region-focusable` (WCAG 2.1.1): the
      // overflow container must be reachable by keyboard. Removing it — or
      // demoting it to -1 — reopens the violation fixed in 8ec243398.
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant}
      onKeyDown={handleKeyDown}
      className={cn(
        maxHeight,
        "min-h-32 transition-[height] motion-reduce:transition-none palette-body-height",
        className
      )}
      style={{
        transitionDuration: `${UI_PALETTE_ENTER_DURATION}ms`,
        transitionTimingFunction: "ease-out",
      }}
      scrollClassName="p-2 space-y-1"
    >
      {children}
    </ScrollShadow>
  );
};

interface AppPaletteFooterProps {
  children?: React.ReactNode;
  className?: string;
}

AppPaletteDialog.Footer = function AppPaletteFooter({
  children,
  className,
}: AppPaletteFooterProps) {
  return (
    <div
      className={cn(
        "px-3 py-2 border-t border-border-strong bg-surface-panel text-xs text-daintree-text/65 flex items-center gap-4",
        className
      )}
    >
      {children ?? <DefaultKeyboardHints />}
    </div>
  );
};

export interface PaletteFooterHint {
  keys: string[];
  label: string;
}

export interface PaletteFooterHintsProps {
  /** Action chip rendered on the leading edge. Never hides. */
  primaryHint: PaletteFooterHint;
  /**
   * Secondary chips rendered on the trailing edge. They drop in reverse order
   * (last hides first) as the footer narrows, so order them by ascending
   * importance — the most-droppable chip last.
   */
  hints: PaletteFooterHint[];
}

function HintChip({ hint, className }: { hint: PaletteFooterHint; className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline shrink-0", className)}>
      {hint.keys.map((key, i) => (
        <kbd key={key} className={cn(KBD_CLASS, i > 0 && "ml-1")}>
          {key}
        </kbd>
      ))}
      <span className="ml-1.5">{hint.label}</span>
    </span>
  );
}

// Width-priority drop classes for secondary chips, matched by index from the
// trailing edge. Index 0 is the rightmost chip (drops first), index 1 is the
// next-to-rightmost, etc. Tailwind needs each variant present in source for the
// JIT compiler — keep as a static array.
const SECONDARY_DROP_CLASSES = [
  "@max-[380px]/palette-footer:hidden",
  "@max-[280px]/palette-footer:hidden",
  "@max-[200px]/palette-footer:hidden",
];

export function PaletteFooterHints({ primaryHint, hints }: PaletteFooterHintsProps) {
  return (
    <div className="@container/palette-footer w-full flex items-center justify-between gap-3">
      <HintChip hint={primaryHint} />
      {hints.length > 0 && (
        <div className="flex items-center gap-3 min-w-0">
          {hints.map((hint, i) => {
            // Map render index → drop priority: rightmost chip (last in array) gets
            // index 0 from the trailing edge, hiding first. Clamp to the table.
            const fromEnd = hints.length - 1 - i;
            const dropClass =
              SECONDARY_DROP_CLASSES[fromEnd] ??
              SECONDARY_DROP_CLASSES[SECONDARY_DROP_CLASSES.length - 1]!;
            return <HintChip key={`${i}-${hint.label}`} hint={hint} className={dropClass} />;
          })}
        </div>
      )}
    </div>
  );
}

function DefaultKeyboardHints() {
  return (
    <PaletteFooterHints
      primaryHint={{ keys: ["↵"], label: "to select" }}
      hints={[
        { keys: ["↑", "↓"], label: "navigate" },
        { keys: ["Esc"], label: "close" },
      ]}
    />
  );
}

interface AppPaletteInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputRef?: React.Ref<HTMLInputElement>;
  /**
   * Optional leading adornment rendered inside the input's border, left of the
   * editable text. Used by `ActionPalette` to surface a mode-prefix chip
   * (e.g. `> Commands`). When present, the input loses its hardcoded left
   * padding so the adornment sits flush with the inner edge.
   */
  inputPrefix?: React.ReactNode;
}

AppPaletteDialog.Input = function AppPaletteInput({
  className,
  inputRef,
  inputPrefix,
  ...props
}: AppPaletteInputProps) {
  if (inputPrefix) {
    return (
      <div
        className={cn(
          "flex w-full items-center gap-1.5 pl-2 pr-3 py-1.5",
          "bg-surface-input border border-daintree-border rounded-[var(--radius-md)]",
          "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
        )}
      >
        {inputPrefix}
        <input
          ref={inputRef}
          type="text"
          className={cn(
            "flex-1 min-w-0 bg-transparent px-0 py-0 text-sm",
            "text-daintree-text placeholder:text-text-placeholder",
            "focus:outline-hidden focus:border-transparent focus:ring-0",
            className
          )}
          {...props}
        />
      </div>
    );
  }
  return (
    <input
      ref={inputRef}
      type="text"
      className={cn(
        "w-full px-3 py-2 text-sm",
        "bg-surface-input border border-daintree-border rounded-[var(--radius-md)]",
        "text-daintree-text placeholder:text-text-placeholder",
        "focus:outline-hidden focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/20",
        className
      )}
      {...props}
    />
  );
};

interface AppPaletteEmptyProps {
  query: string;
  emptyMessage?: string;
  noMatchMessage?: string;
  noMatchContent?: React.ReactNode;
  children?: React.ReactNode;
}

const NO_MATCH_QUERY_MAX = 40;
const EMPTY_ANNOUNCEMENT_DEBOUNCE_MS = 600;

function defaultNoMatchTitle(trimmedQuery: string) {
  // Iterate by codepoint (Array.from handles surrogate pairs) so we never
  // truncate inside an astral-plane character like an emoji.
  const codepoints = Array.from(trimmedQuery);
  const display =
    codepoints.length > NO_MATCH_QUERY_MAX
      ? `${codepoints.slice(0, NO_MATCH_QUERY_MAX).join("")}…`
      : trimmedQuery;
  return `No matches for "${display}"`;
}

AppPaletteDialog.Empty = function AppPaletteEmpty({
  query,
  emptyMessage = "No items available",
  noMatchMessage,
  noMatchContent,
  children,
}: AppPaletteEmptyProps) {
  const trimmedQuery = query.trim();
  // Defer the *displayed* query so the title doesn't redraw every keystroke
  // while a fast typist is filling the input. The branch decision still uses
  // the immediate `trimmedQuery` so clearing the input flips back to
  // zero-data without a stale "No matches for ..." flash.
  const deferredTrimmedQuery = useDeferredValue(trimmedQuery);
  // When the urgent query is ahead of the deferred one, the user is mid-keystroke
  // and the empty state is churning — suppress the fade so it doesn't strobe. The
  // length guard keeps the crossfade when the input is cleared back to empty (the
  // deferred value briefly lags behind "", which would otherwise read as stale).
  const isStale = trimmedQuery !== deferredTrimmedQuery && trimmedQuery.length > 0;

  // Debounced sr-only live region so screen readers announce the empty/no-match
  // title once typing stops, rather than on every keystroke. Follows the
  // SidebarContent trailing-debounce + clear-then-set precedent so Chromium
  // doesn't suppress repeated identical announcements.
  const srTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [srAnnouncement, setSrAnnouncement] = useState("");
  const displayQuery = deferredTrimmedQuery || trimmedQuery;
  const title = trimmedQuery ? (noMatchMessage ?? defaultNoMatchTitle(displayQuery)) : emptyMessage;

  useEffect(() => {
    return () => {
      if (srTimerRef.current !== null) clearTimeout(srTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setSrAnnouncement("");
    if (srTimerRef.current !== null) clearTimeout(srTimerRef.current);
    srTimerRef.current = setTimeout(() => {
      setSrAnnouncement(title);
    }, EMPTY_ANNOUNCEMENT_DEBOUNCE_MS);
    return () => {
      if (srTimerRef.current !== null) clearTimeout(srTimerRef.current);
    };
  }, [title, trimmedQuery]);

  if (trimmedQuery) {
    return (
      <>
        <EmptyState
          variant="filtered-empty"
          scale="popover"
          title={title}
          action={noMatchContent}
          className="px-3 py-8"
          instant={isStale}
        />
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {srAnnouncement}
        </div>
      </>
    );
  }
  return (
    <>
      <EmptyState
        variant="zero-data"
        scale="popover"
        title={title}
        action={children}
        className="px-3 py-8"
        instant={isStale}
      />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {srAnnouncement}
      </div>
    </>
  );
};
