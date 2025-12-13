import { useEffect, useRef, useCallback, useId, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";
import { X } from "lucide-react";

type DialogSize = "sm" | "md" | "lg" | "xl";

interface AppDialogContextValue {
  onClose: () => void;
  titleId: string;
  descriptionId: string;
}

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

export interface AppDialogProps {
  isOpen: boolean;
  onClose: () => void;
  size?: DialogSize;
  dismissible?: boolean;
  children: React.ReactNode;
  className?: string;
}

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
};

export function AppDialog({
  isOpen,
  onClose,
  size = "md",
  dismissible = true,
  children,
  className,
}: AppDialogProps) {
  useOverlayState(isOpen);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
    } else if (previousActiveElement.current) {
      previousActiveElement.current.focus();
      previousActiveElement.current = null;
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        onClose();
      }
    },
    [dismissible, onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && dismissible) {
        onClose();
      }
    },
    [dismissible, onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <AppDialogContext.Provider value={{ onClose, titleId, descriptionId }}>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm backdrop-saturate-50"
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div
          className={cn(
            "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-xl)] shadow-modal mx-4 flex flex-col max-h-[80vh]",
            sizeClasses[size],
            "w-full",
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
  return <div className={cn("flex-1 overflow-y-auto p-6", className)}>{children}</div>;
};

interface AppDialogFooterProps {
  children: React.ReactNode;
  className?: string;
}

AppDialog.Footer = function AppDialogFooter({ children, className }: AppDialogFooterProps) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-t border-canopy-border flex justify-end gap-3 shrink-0",
        className
      )}
    >
      {children}
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
