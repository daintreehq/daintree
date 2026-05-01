import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useOverlayState, useEscapeStack } from "@/hooks";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePaletteStore } from "@/store/paletteStore";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
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
    if (previousFocusRef.current) {
      if (!usePaletteStore.getState().activePaletteId) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    animationDuration: getUiTransitionDuration("exit"),
    onAnimateOut: restoreFocus,
  });

  useOverlayState(isOpen || shouldRender);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => {
        const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();
      });
    }
  }, [isOpen]);

  // Backstop Escape on document bubble. The bubble-phase escape
  // stack dispatcher (`useGlobalEscapeDispatcher`) bails when
  // `defaultPrevented` is true, which Radix DismissableLayers
  // (tooltips, popovers) set in capture phase even mid-exit.
  // Document-bubble fires after target handlers but ignores
  // defaultPrevented; inner handlers can still opt out by calling
  // `e.stopPropagation()`.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.repeat) return;
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])'
        );
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
        transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
        transitionTimingFunction: "linear",
      }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={dialogRef}
        className={cn(
          "w-full max-w-xl mx-4 bg-daintree-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden origin-top",
          "transition-[opacity,transform]",
          "motion-reduce:transition-opacity motion-reduce:scale-100",
          isVisible ? "opacity-100 scale-100" : "opacity-0 scale-[0.96]",
          className
        )}
        style={{
          transitionDuration: isVisible
            ? `${UI_PALETTE_ENTER_DURATION}ms`
            : `${UI_PALETTE_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
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
  keyHint?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Show an indeterminate loading bar pinned to the bottom of the header.
   * The bar fades in after a short grace period (UI_PALETTE_ENTER_DURATION),
   * so fast loads never flash a sweep.
   */
  isLoading?: boolean;
}

AppPaletteDialog.Header = function AppPaletteHeader({
  label,
  keyHint,
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
        {keyHint && <span className="font-mono">{keyHint}</span>}
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
          transitionDelay: isLoading ? `${UI_PALETTE_ENTER_DURATION}ms` : "0ms",
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
    <ScrollShadow tabIndex={0} className={cn(maxHeight, className)} scrollClassName="p-2 space-y-1">
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
      {children || <DefaultKeyboardHints />}
    </div>
  );
};

export interface PaletteFooterHint {
  keys: string[];
  label: string;
}

export interface PaletteFooterHintsProps {
  primaryHint: PaletteFooterHint;
  hints: PaletteFooterHint[];
}

export function PaletteFooterHints({ primaryHint, hints }: PaletteFooterHintsProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="w-full flex items-center justify-between">
      <span>
        {primaryHint.keys.map((key, i) => (
          <kbd key={key} className={cn(KBD_CLASS, i > 0 && "ml-1")}>
            {key}
          </kbd>
        ))}
        <span className="ml-1.5">{primaryHint.label}</span>
      </span>
      <Popover open={helpOpen} onOpenChange={setHelpOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="p-0.5 rounded transition-colors text-daintree-text/40 hover:text-daintree-text/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            aria-label="Keyboard shortcuts"
          >
            <CircleHelp className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-auto p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-1.5 text-xs text-daintree-text/60">
            {hints.map(({ keys, label }) => (
              <span key={label}>
                {keys.map((key, i) => (
                  <kbd key={key} className={cn(KBD_CLASS, i > 0 && "ml-1")}>
                    {key}
                  </kbd>
                ))}
                <span className="ml-1.5">{label}</span>
              </span>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DefaultKeyboardHints() {
  return (
    <PaletteFooterHints
      primaryHint={{ keys: ["↵"], label: "to select" }}
      hints={[
        { keys: ["↑", "↓"], label: "to navigate" },
        { keys: ["↵"], label: "to select" },
        { keys: ["Esc"], label: "to close" },
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
  children?: React.ReactNode;
}

AppPaletteDialog.Empty = function AppPaletteEmpty({
  query,
  emptyMessage = "No items available",
  noMatchMessage,
  children,
}: AppPaletteEmptyProps) {
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    return (
      <EmptyState
        variant="filtered-empty"
        title={noMatchMessage || `No items match "${trimmedQuery}"`}
        className="px-3 py-8"
      />
    );
  }
  return (
    <EmptyState variant="zero-data" title={emptyMessage} action={children} className="px-3 py-8" />
  );
};
