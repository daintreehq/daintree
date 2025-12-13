import { useCallback } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";

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
  useOverlayState(isOpen);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm backdrop-saturate-[1.25]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className={cn(
          "w-full max-w-xl mx-4 bg-canopy-bg border border-canopy-border rounded-[var(--radius-xl)] shadow-2xl overflow-hidden",
          "animate-in fade-in slide-in-from-top-4 duration-150",
          className
        )}
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
    <div className={cn("overflow-y-auto p-2 space-y-1", maxHeight, className)}>{children}</div>
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

function DefaultKeyboardHints() {
  return (
    <>
      <span>
        <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
          ↑
        </kbd>
        <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60 ml-1">
          ↓
        </kbd>
        <span className="ml-1.5">to navigate</span>
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
          Enter
        </kbd>
        <span className="ml-1.5">to select</span>
      </span>
      <span>
        <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
          Esc
        </kbd>
        <span className="ml-1.5">to close</span>
      </span>
    </>
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
        "text-canopy-text placeholder:text-canopy-text/40",
        "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent",
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
      {children}
    </div>
  );
};
