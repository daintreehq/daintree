import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface HelpIntroBannerProps {
  onDismiss: () => void;
  onLinkClick: () => void;
}

export function HelpIntroBanner({ onDismiss, onLinkClick }: HelpIntroBannerProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onDismiss();
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 shrink-0",
        "bg-wash-subtle border-b border-subtle text-[11px] text-text-secondary"
      )}
      onKeyDown={handleKeyDown}
    >
      <span className="flex-1 min-w-0 truncate">
        New here?{" "}
        <button
          type="button"
          onClick={onLinkClick}
          className={cn(
            "text-text-primary underline underline-offset-4",
            "decoration-border-subtle hover:decoration-text-primary",
            "transition-colors"
          )}
        >
          See what the Daintree Assistant can do
        </button>
        .
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-text-muted hover:text-text-secondary transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
