import { InlineStatusBanner } from "./InlineStatusBanner";
import { actionService } from "@/services/ActionService";

/**
 * Above a guided Decisions relay update (#16201): the way back to Settings,
 * which checks the relay again once the update's command ends and shows the
 * version it found. Nothing here reads what the terminal printed.
 */
export function RelayUpdateBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <InlineStatusBanner
      severity="info"
      title="Settings checks the relay when the update ends"
      description="The update asks before changing anything. Afterwards, Settings → Decisions shows the version the relay runs."
      action={{
        id: "show-decisions-relay-update",
        label: "Open Decisions settings",
        onClick: () => {
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "decisions", sectionId: "decisions-connection" },
            { source: "user" }
          );
        },
      }}
      onClose={onDismiss}
    />
  );
}
