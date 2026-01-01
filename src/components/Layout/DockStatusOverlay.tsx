import { AlertCircle, XCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DockStatusOverlayProps {
  waitingCount: number;
  failedCount: number;
  trashedCount: number;
}

export function DockStatusOverlay({
  waitingCount,
  failedCount,
  trashedCount,
}: DockStatusOverlayProps) {
  const hasAny = waitingCount > 0 || failedCount > 0 || trashedCount > 0;
  if (!hasAny) return null;

  return (
    <div
      className={cn(
        "absolute bottom-2 right-4 z-50",
        "flex items-center gap-2",
        "pointer-events-none"
      )}
      aria-live="polite"
      aria-label="Dock status indicators"
    >
      {waitingCount > 0 && (
        <StatusChip
          icon={<AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
          count={waitingCount}
          label="waiting"
          variant="waiting"
        />
      )}
      {failedCount > 0 && (
        <StatusChip
          icon={<XCircle className="w-3.5 h-3.5 text-red-400" />}
          count={failedCount}
          label="failed"
          variant="failed"
        />
      )}
      {trashedCount > 0 && (
        <StatusChip
          icon={<Trash2 className="w-3.5 h-3.5 text-canopy-text/60" />}
          count={trashedCount}
          label="trashed"
          variant="trash"
        />
      )}
    </div>
  );
}

interface StatusChipProps {
  icon: React.ReactNode;
  count: number;
  label: string;
  variant: "waiting" | "failed" | "trash";
}

function StatusChip({ icon, count, label }: StatusChipProps) {
  return (
    <div
      className={cn(
        "pointer-events-auto",
        "flex items-center gap-1.5 px-2 py-1",
        "rounded-full",
        "bg-[var(--dock-bg)]/95 backdrop-blur-sm",
        "border border-[var(--dock-border)]",
        "shadow-lg",
        "text-xs font-medium text-canopy-text/80"
      )}
      role="status"
      aria-label={`${count} ${label}`}
    >
      {icon}
      <span>{count}</span>
    </div>
  );
}
