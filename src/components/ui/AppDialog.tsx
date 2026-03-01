import { useEffect, useRef, useCallback, useId, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";
import { useSidecarStore } from "@/store";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
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
}

export type { DialogSize, DialogVariant, DialogZIndex };

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
}: AppDialogProps) {
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const backdropPointerRef = useRef<number | null>(null);
  const closeInFlightRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  const { isOpen: sidecarOpen, width: sidecarWidth } = useSidecarStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );
  const sidecarOffset = sidecarOpen ? sidecarWidth : 0;

  const restoreFocus = useCallback(() => {
    if (previousActiveElement.current) {
      previousActiveElement.current.focus();
      previousActiveElement.current = null;
    }
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    onAnimateOut: restoreFocus,
  });

  useOverlayState(isOpen || shouldRender);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    },
    [handleClose]
  );

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
          "fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-md backdrop-saturate-[1.25]",
          zIndex === "nested" ? "z-[var(--z-nested-dialog)]" : "z-[var(--z-modal)]",
          "transition-opacity duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0",
          isVisible ? "opacity-100" : "opacity-0"
        )}
        style={{ right: sidecarOffset }}
        onPointerDown={handleBackdropPointerDown}
        onPointerUp={handleBackdropPointerUp}
        onPointerCancel={resetBackdropPointer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div
          className={cn(
            "bg-canopy-sidebar border border-[var(--border-overlay)] border-t-white/[0.08] rounded-[var(--radius-xl)] shadow-modal mx-4 flex flex-col",
            maxHeight,
            sizeClasses[size],
            "w-full",
            "transition-all duration-150",
            "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
            isVisible
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 translate-y-1 scale-[0.98]",
            className
          )}
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
        "px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 flex items-center justify-between shrink-0",
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
        "text-canopy-text/60 hover:text-canopy-text transition-colors p-1 rounded",
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
