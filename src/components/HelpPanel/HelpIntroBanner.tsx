import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface HelpIntroBannerProps {
  onDismiss: () => void;
}

export function HelpIntroBanner({ onDismiss }: HelpIntroBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 shrink-0",
        "bg-overlay-subtle border-b border-border-default text-2xs text-daintree-text/50"
      )}
    >
      <span className="flex-1 min-w-0 truncate">
        Tip: Press <kbd className="text-daintree-text/70">Shift+Enter</kbd> to add a newline without
        sending.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-daintree-text/50 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
