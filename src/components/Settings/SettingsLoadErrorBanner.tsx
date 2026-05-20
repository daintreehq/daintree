import { AlertCircle } from "lucide-react";

interface SettingsLoadErrorBannerProps {
  message: string;
  onRetry: () => void;
}

export function SettingsLoadErrorBanner({ message, onRetry }: SettingsLoadErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/10 px-3 py-2"
    >
      <AlertCircle className="w-4 h-4 text-status-error shrink-0" aria-hidden="true" />
      <p className="text-xs text-status-error flex-1 select-text">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs px-2 py-1 rounded-sm border border-status-error/30 text-status-error hover:bg-status-error/10 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
