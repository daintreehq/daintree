import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

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

/**
 * The words stay on the neutral text ramp and only the glyph and tint carry the status
 * colour: status-coloured text has no contrast floor across the themes, and a
 * slash-alpha text colour can't be recovered at all.
 */
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
        {title && <p className="text-xs font-medium text-text-primary">{title}</p>}
        <p className="text-xs text-text-secondary select-text break-words">{message}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} className="shrink-0">
        {retryLabel}
      </Button>
    </div>
  );
}
