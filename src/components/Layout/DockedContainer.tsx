import { PanelBottom } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DockedContainerProps {
  dockedCount: number;
  compact?: boolean;
  onClick: () => void;
}

export function DockedContainer({ dockedCount, compact = false, onClick }: DockedContainerProps) {
  if (dockedCount === 0) return null;

  return (
    <Button
      variant="pill"
      size="sm"
      onClick={onClick}
      className={cn(compact ? "px-1.5 min-w-0" : "px-3")}
      title={`${dockedCount} terminal${dockedCount > 1 ? "s" : ""} in dock`}
      aria-label={`Docked: ${dockedCount} terminal${dockedCount > 1 ? "s" : ""}`}
    >
      <span className="relative">
        <PanelBottom className="w-3.5 h-3.5 text-canopy-accent" aria-hidden="true" />
        {compact && dockedCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-canopy-accent text-[10px] font-bold text-canopy-bg shadow-sm">
            {dockedCount > 9 ? "9+" : dockedCount}
          </span>
        )}
      </span>
      {!compact && <span className="font-medium">Docked ({dockedCount})</span>}
    </Button>
  );
}
