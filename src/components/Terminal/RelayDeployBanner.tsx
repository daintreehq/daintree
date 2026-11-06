import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { requestRelayUrl } from "@/components/Settings/Decisions/relayUrlRequest";

/**
 * Above a guided Decisions relay deploy (#16023): what happens when it ends,
 * and the way back to Settings to see it. Main claims the relay a completed
 * deploy reports over its host channel by itself (#16200), so the way back
 * lands on Connection's relay row, where that claim's outcome shows, filled
 * with the Worker URL when nothing claimed it. The row exists only once
 * Connection renders, after the dialog's own landing has looked for it, so
 * the request lands it then; the section target still keeps the dialog from
 * putting focus in its search. Nothing here reads what the terminal printed.
 */
export function RelayDeployBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <InlineStatusBanner
      severity="info"
      title="Daintree connects the relay when the deploy finishes"
      description="When it succeeds, Daintree checks the new relay and claims it with this computer's Decisions identity, holding the claim secret in memory only. Settings shows how it went. Daintree doesn't save this terminal's contents."
      action={{
        id: "connect-decisions-relay",
        label: "Show in Settings…",
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
