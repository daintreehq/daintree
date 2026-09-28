import { Callout } from "@/components/ui/Callout";
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
    <Callout
      severity="error"
      role="alert"
      title={title}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      }
    >
      <p className="select-text">{message}</p>
    </Callout>
  );
}
