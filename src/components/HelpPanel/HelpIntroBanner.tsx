import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";

interface HelpIntroBannerProps {
  onDismiss: () => void;
}

export function HelpIntroBanner({ onDismiss }: HelpIntroBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 shrink-0",
        "bg-overlay-subtle border-b border-border-default text-2xs text-text-secondary"
      )}
    >
      <span className="flex-1 min-w-0 truncate">
        Tip: Press <KbdChord shortcut="Shift+Enter" density="compact" /> to add a newline without
        sending.
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-my-1"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
