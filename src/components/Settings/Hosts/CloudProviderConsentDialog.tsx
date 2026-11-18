import { AppDialog } from "@/components/ui/AppDialog";
import { InlineError } from "@/components/ui/field";
import type { CloudProviderInfo, CloudProviderPluginConsent } from "@shared/types/cloudHosts";

interface CloudProviderConsentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  provider: CloudProviderInfo;
  plugin: CloudProviderPluginConsent;
  /** Connecting an account, or allowing a plugin whose saved accounts are paused. */
  purpose: "connect" | "replace" | "review";
  onAllow: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * Before a plugin's cloud provider is handed any credentials (#17352): who
 * the person is trusting and with what. Cancelling sends nothing and keeps
 * nothing; allowing covers every provider the plugin declares now, and is
 * asked again when an update changes what any of them asks for or does.
 */
export function CloudProviderConsentDialog({
  isOpen,
  onClose,
  provider,
  plugin,
  purpose,
  onAllow,
  busy = false,
  error = null,
}: CloudProviderConsentDialogProps) {
  const others = plugin.providerNames.filter((name) => name !== provider.name);
  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      dismissible={!busy}
      data-testid="cloud-provider-consent-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>{`Allow ${plugin.pluginName} to use your cloud accounts?`}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-3 text-sm text-text-secondary">
          <p>
            {provider.name} comes from the{" "}
            <span className="font-medium text-text-primary">{plugin.pluginName}</span> plugin (
            <code className="text-xs">{plugin.pluginId}</code>), not from Daintree. Once you allow
            it, the plugin:
          </p>
          <ul className="list-disc space-y-1.5 pl-5" data-testid="cloud-provider-consent-terms">
            <li>
              {purpose === "review"
                ? "Receives the credentials saved for its accounts on this device"
                : purpose === "replace"
                  ? "Receives the credentials you enter, and once they replace the old ones, those saved for any of its accounts on this device"
                  : "Receives the credentials you enter, including when you check them, and once you connect, those saved for any of its accounts on this device"}
            </li>
            <li>Chooses the machines Daintree connects to, and vouches for their identity</li>
            <li>Creates machines that bill your own account</li>
          </ul>
          <p>
            {others.length > 0
              ? `This covers its other cloud providers too (${others.join(", ")}). `
              : ""}
            {purpose === "review"
              ? "Its accounts on this device stay paused until you allow it. "
              : ""}
            Daintree asks again if an update changes what the plugin asks for or does.
          </p>
          {error && <InlineError role="alert">{error}</InlineError>}
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={{
          label: purpose === "review" ? "Allow access" : "Allow and continue",
          onClick: onAllow,
          disabled: busy,
          loading: busy,
        }}
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: busy }}
      />
    </AppDialog>
  );
}
