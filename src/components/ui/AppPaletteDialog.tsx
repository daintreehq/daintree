import { useCallback, useDeferredValue, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { KbdChord } from "@/components/ui/Kbd";
import { useOverlayState, useEscapeStack } from "@/hooks";
import {
  registerDialogEscapeBackstop,
  isTopmostDialogBackstop,
  radixLayerWasOpenWhenEscapePressed,
  markBackstopConsumedEscape,
} from "@/lib/dialogEscapeBackstop";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePaletteStore } from "@/store/paletteStore";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_DOHERTY_THRESHOLD,
  getUiPaletteTransitionDuration,
} from "@/lib/animationUtils";

export const KBD_CLASS =
  "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-daintree-border text-daintree-text/60";

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
    // own focus, so skip restore entirely.
    if (usePaletteStore.getState().activePaletteId) return;
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

  useEffect(() => {
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
        "fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-scrim-medium backdrop-blur-sm backdrop-saturate-[1.25]",
        "transition-opacity",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={{
        transitionDuration: isVisible
          ? `${UI_PALETTE_ENTER_DURATION}ms`
          : `${UI_PALETTE_EXIT_DURATION}ms`,
        transitionTimingFunction: "linear",
      }}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "w-full max-w-xl mx-4 bg-daintree-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden origin-top",
          "transition-[opacity,transform]",
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
            "--scroll-shadow-color": "var(--color-surface-canvas)",
          } as CSSProperties
        }
        onClick={(e) => e.stopPropagation()}
      >
        {children}
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
   * The bar fades in after the 400ms Doherty threshold, so fast loads never
   * flash a sweep.
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
        "relative overflow-hidden px-3 pt-2 pb-1 border-b border-daintree-border",
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
          transitionDelay: isLoading ? `${UI_DOHERTY_THRESHOLD}ms` : "0ms",
        }}
      >
        <div className="palette-loading-bar__sweep" />
      </div>
    </div>
  );
};

interface AppPaletteBodyProps {
  children: React.ReactNode;
  className?: string;
  maxHeight?: string;
}

AppPaletteDialog.Body = function AppPaletteBody({
  children,
  className,
  maxHeight = "max-h-[50vh]",
}: AppPaletteBodyProps) {
  return (
    <ScrollShadow
      tabIndex={0}
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
        "px-3 py-2 border-t border-daintree-border bg-daintree-sidebar/50 text-xs text-daintree-text/50 flex items-center gap-4",
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
}

AppPaletteDialog.Input = function AppPaletteInput({
  className,
  inputRef,
  ...props
}: AppPaletteInputProps) {
  return (
    <input
      ref={inputRef}
      type="text"
      className={cn(
        "w-full px-3 py-2 text-sm",
        "bg-daintree-sidebar border border-daintree-border rounded-[var(--radius-md)]",
        "text-daintree-text placeholder:text-text-muted",
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
  if (trimmedQuery) {
    const displayQuery = deferredTrimmedQuery || trimmedQuery;
    return (
      <EmptyState
        variant="filtered-empty"
        scale="popover"
        title={noMatchMessage ?? defaultNoMatchTitle(displayQuery)}
        action={noMatchContent}
        className="px-3 py-8"
      />
    );
  }
  return (
    <EmptyState
      variant="zero-data"
      scale="popover"
      title={emptyMessage}
      action={children}
      className="px-3 py-8"
    />
  );
};
