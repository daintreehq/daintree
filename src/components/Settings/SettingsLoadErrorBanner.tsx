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
  /** Gives up the unsaved edit the failure is holding, beside Retry. */
  onDiscard?: () => void;
  /** Lets a settings landing find the banner. */
  id?: string;
  /**
   * Changing it re-announces the message while the banner, and the Retry that may
   * hold focus, stay mounted: a retry failing the same way would otherwise be silent.
   */
  announceKey?: number;
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
  onDiscard,
  id,
  announceKey,
}: SettingsLoadErrorBannerProps) {
  const retry = (
    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
      {retryLabel}
    </Button>
  );
  return (
    <Callout
      severity="error"
      role="alert"
      id={id}
      title={title}
      action={onDiscard ? undefined : retry}
    >
      <p key={announceKey} className="select-text">
        {message}
      </p>
      {/* Two ways forward sit under the words, Retry first: a landing on the banner
          focuses its first button, and that mustn't be the one that drops the edit. */}
      {onDiscard && (
        <div className="mt-2 flex flex-wrap gap-2">
          {retry}
          <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
            Discard changes
          </Button>
        </div>
      )}
    </Callout>
  );
}
