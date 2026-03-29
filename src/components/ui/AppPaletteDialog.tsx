import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useOverlayState, useEscapeStack } from "@/hooks";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePaletteStore } from "@/store/paletteStore";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";

export const KBD_CLASS =
  "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60";

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
      }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={dialogRef}
        className={cn(
          "w-full max-w-xl mx-4 bg-canopy-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden",
          "transition-[opacity,transform]",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 -translate-y-3 scale-[0.97]",
          className
        )}
        style={{
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
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
}

AppPaletteDialog.Header = function AppPaletteHeader({
  label,
  keyHint,
  children,
  className,
}: AppPaletteHeaderProps) {
  return (
    <div className={cn("px-3 pt-2 pb-1 border-b border-canopy-border", className)}>
      <div className="flex justify-between items-center mb-1.5 text-[11px] text-canopy-text/50">
        <span>{label}</span>
        {keyHint && <span className="font-mono">{keyHint}</span>}
      </div>
      {children}
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
    <div tabIndex={0} className={cn("overflow-y-auto p-2 space-y-1", maxHeight, className)}>
      {children}
    </div>
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
        "px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4",
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
            className="p-0.5 rounded transition-colors text-canopy-text/40 hover:text-canopy-text/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
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
          <div className="flex flex-col gap-1.5 text-xs text-canopy-text/60">
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
        "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
        "text-canopy-text placeholder:text-text-muted",
        "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/20",
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
  return (
    <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
      {query.trim() ? <>{noMatchMessage || `No items match "${query}"`}</> : <>{emptyMessage}</>}
      {!query.trim() && children}
    </div>
  );
};
