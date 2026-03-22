import { useEffect, useRef, useCallback, useId, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useOverlayState, useEscapeStack } from "@/hooks";
import { usePortalStore } from "@/store";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import { X, Loader2 } from "lucide-react";
import { Button } from "./button";

type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl" | "4xl" | "6xl";
type DialogVariant = "default" | "destructive" | "info";
type DialogZIndex = "modal" | "nested";

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
  dismissible?: boolean;
  children: React.ReactNode;
  className?: string;
  maxHeight?: string;
  zIndex?: DialogZIndex;
  "data-testid"?: string;
}

export type { DialogSize, DialogVariant, DialogZIndex };

const TABBABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"])';

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
  "2xl": "max-w-4xl",
  "4xl": "max-w-4xl",
  "6xl": "max-w-6xl",
};

export function AppDialog({
  isOpen,
  onClose,
  onBeforeClose,
  size = "md",
  variant = "default",
  dismissible = true,
  children,
  className,
  maxHeight = "max-h-[80vh]",
  zIndex = "modal",
  "data-testid": dataTestId,
}: AppDialogProps) {
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const backdropPointerRef = useRef<number | null>(null);
  const closeInFlightRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const { isOpen: portalOpen, width: portalWidth } = usePortalStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );
  const portalOffset = portalOpen ? portalWidth : 0;

  const restoreFocus = useCallback(() => {
    if (previousActiveElement.current) {
      previousActiveElement.current.focus();
      previousActiveElement.current = null;
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
      previousActiveElement.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>(TABBABLE_SELECTOR);
        if (first) {
          first.focus();
        } else {
          dialogRef.current?.focus();
        }
      });
    } else {
      restoreFocus();
    }
  }, [isOpen, restoreFocus]);

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
      console.error("AppDialog onBeforeClose failed", error);
    } finally {
      closeInFlightRef.current = false;
    }
  }, [dismissible, onBeforeClose, onClose]);

  useEscapeStack(isOpen, handleClose);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Tab" && dialogRef.current) {
      // Don't interfere if another modal (e.g., a nested dialog portal) has focus
      const activeEl = document.activeElement;
      if (activeEl) {
        const closestModal = activeEl.closest('[aria-modal="true"]');
        if (closestModal && !closestModal.contains(dialogRef.current)) return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)
      );

      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

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
          "fixed inset-0 flex items-center justify-center bg-scrim-medium backdrop-blur-md backdrop-saturate-[1.25]",
          zIndex === "nested" ? "z-[var(--z-nested-dialog)]" : "z-[var(--z-modal)]",
          "transition-opacity",
          "motion-reduce:transition-none motion-reduce:duration-0",
          isVisible ? "opacity-100" : "opacity-0"
        )}
        style={{
          right: portalOffset,
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
        }}
        onPointerDown={handleBackdropPointerDown}
        onPointerUp={handleBackdropPointerUp}
        onPointerCancel={resetBackdropPointer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid={dataTestId}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          className={cn(
            "bg-surface-panel border border-border-default rounded-[var(--radius-xl)] shadow-[var(--theme-shadow-dialog)] mx-4 flex flex-col overflow-hidden",
            maxHeight,
            sizeClasses[size],
            "w-full",
            "transition-[opacity,transform]",
            "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
            isVisible
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 translate-y-1 scale-[0.98]",
            "outline-none",
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
      </div>
    </AppDialogContext.Provider>,
    document.body
  );
}

interface AppDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.Header = function AppDialogHeader({ children, className }: AppDialogHeaderProps) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-b border-canopy-border bg-overlay-soft flex items-center justify-between shrink-0",
        className
      )}
    >
      {children}
    </div>
  );
};

interface AppDialogTitleProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

AppDialog.Title = function AppDialogTitle({ children, icon, className }: AppDialogTitleProps) {
  const context = useContext(AppDialogContext);
  return (
    <h2
      id={context?.titleId}
      className={cn("text-lg font-semibold text-canopy-text flex items-center gap-2", className)}
    >
      {icon}
      {children}
    </h2>
  );
};

interface AppDialogCloseButtonProps {
  className?: string;
}

AppDialog.CloseButton = function AppDialogCloseButton({ className }: AppDialogCloseButtonProps) {
  const context = useContext(AppDialogContext);
  return (
    <button
      type="button"
      onClick={context?.onClose}
      className={cn(
        "text-canopy-text/60 hover:text-canopy-text hover:bg-overlay-strong transition-colors p-1 rounded",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
        className
      )}
      aria-label="Close dialog"
    >
      <X className="h-5 w-5" />
    </button>
  );
};

interface AppDialogBodyProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.Body = function AppDialogBody({ children, className }: AppDialogBodyProps) {
  return <div className={cn("flex-1 overflow-y-auto min-h-0 p-6", className)}>{children}</div>;
};

interface AppDialogBodyScrollProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.BodyScroll = function AppDialogBodyScroll({
  children,
  className,
}: AppDialogBodyScrollProps) {
  return <div className={cn("flex-1 overflow-auto min-h-0 p-6", className)}>{children}</div>;
};

export interface DialogAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  intent?: "default" | "destructive" | "primary";
}

interface AppDialogFooterProps {
  children?: React.ReactNode;
  className?: string;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
}

AppDialog.Footer = function AppDialogFooter({
  children,
  className,
  primaryAction,
  secondaryAction,
}: AppDialogFooterProps) {
  const context = useContext(AppDialogContext);
  const dialogVariant = context?.variant ?? "default";

  const getPrimaryVariant = () => {
    if (primaryAction?.intent === "destructive" || dialogVariant === "destructive") {
      return "destructive";
    }
    return "default";
  };

  return (
    <div
      className={cn(
        "px-6 py-4 border-t border-canopy-border flex justify-end gap-3 shrink-0",
        className
      )}
    >
      {children}
      {!children && secondaryAction && (
        <Button
          variant="ghost"
          onClick={secondaryAction.onClick}
          disabled={secondaryAction.disabled || secondaryAction.loading}
          className="text-canopy-text/70 hover:text-canopy-text"
        >
          {secondaryAction.loading && <Loader2 className="animate-spin" />}
          {secondaryAction.label}
        </Button>
      )}
      {!children && primaryAction && (
        <Button
          variant={getPrimaryVariant()}
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled || primaryAction.loading}
        >
          {primaryAction.loading && <Loader2 className="animate-spin" />}
          {primaryAction.label}
        </Button>
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
    <p id={context?.descriptionId} className={cn("text-sm text-canopy-text/70", className)}>
      {children}
    </p>
  );
};
