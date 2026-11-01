import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { requestRelayUrl } from "@/components/Settings/Decisions/relayUrlRequest";

/**
 * Above a guided Decisions relay deploy (#16023): the way back to Settings,
 * landing on the relay URL field, for the Worker URL and claim secret the
 * deploy shows. The row exists only once Connection renders, after the
 * dialog's own landing has looked for it, so the request lands it then; the
 * section target still keeps the dialog from putting focus in its search.
 * Nothing here reads what the terminal printed.
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
            { tab: "decisions", sectionId: "decisions-relay-url" },
            { source: "user" }
          );
        },
      }}
      onClose={onDismiss}
    />
  );
}
