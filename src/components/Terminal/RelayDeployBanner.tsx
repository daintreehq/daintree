import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { requestRelayUrl } from "@/components/Settings/Decisions/relayUrlRequest";

/**
 * Above a guided Decisions relay deploy (#16023): the way back to Settings,
 * landing on the relay URL field, for the Worker URL and claim secret the
 * deploy shows. The landing waits for Connection to render, so it isn't the
 * dialog's own section target. Nothing here reads what the terminal printed.
 */
export function RelayDeployBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <InlineStatusBanner
      severity="info"
      title="Connect the relay when the deploy finishes"
      description="Enter the Worker URL and claim secret it shows in Settings. Daintree doesn't save this terminal's contents."
      action={{
        id: "connect-decisions-relay",
        label: "Connect relay…",
        onClick: () => {
          requestRelayUrl();
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "decisions" },
            { source: "user" }
          );
        },
      }}
      onClose={onDismiss}
    />
  );
}
