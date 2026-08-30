import { AlertCircle } from "lucide-react";

interface SettingsLoadErrorBannerProps {
  message: string;
  onRetry: () => void;
  /**
   * Headline above the message. Use it when the message alone doesn't say what
   * failed — a raw errno on its own tells the user nothing about which operation
   * or whose settings it belongs to.
   */
  title?: string;
  /** Defaults to "Retry" — the recovery verb for inline banners. */
  retryLabel?: string;
}

export function SettingsLoadErrorBanner({
  message,
  onRetry,
  title,
  retryLabel = "Retry",
}: SettingsLoadErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/10 px-3 py-2"
    >
      <AlertCircle className="w-4 h-4 text-status-error shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {title && <p className="text-xs font-medium text-status-error">{title}</p>}
        <p className="text-xs text-status-error/90 select-text break-words">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs px-2 py-1 rounded-sm border border-status-error/30 text-status-error hover:bg-status-error/10 transition-colors shrink-0"
      >
        {retryLabel}
      </button>
    </div>
  );
}
