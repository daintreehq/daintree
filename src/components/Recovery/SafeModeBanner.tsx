import { AlertTriangle } from "lucide-react";

export function SafeModeBanner() {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-status-warning)]/15 border-b border-[var(--color-status-warning)]/30 text-[var(--color-status-warning)] text-sm shrink-0">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>Safe mode — the app booted without restoring panels due to repeated crashes.</span>
    </div>
  );
}
