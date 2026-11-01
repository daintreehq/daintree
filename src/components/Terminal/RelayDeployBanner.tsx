import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";

/**
 * Above a guided Decisions relay deploy (#16023): the way back to Settings,
 * landing on the relay URL field, for the Worker URL and claim secret the
 * deploy shows. Nothing here reads what the terminal printed.
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
        onClick: () =>
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "decisions", sectionId: "decisions-relay-url" },
            { source: "user" }
          ),
      }}
      onClose={onDismiss}
    />
  );
}
