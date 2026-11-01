import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsStatus } from "@shared/types/decisions";

function relayHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** What was observed about the relay, in words; never what it implies about agents. */
function describeConnection(status: DecisionsStatus): { label: string; detail?: string } {
  const host = relayHost(status.relayOrigin);
  switch (status.state) {
    case "connected":
      return { label: host ? `Connected to ${host}` : "Connected" };
    case "connecting":
      return {
        label: host ? `Connecting to ${host}` : "Connecting",
        detail: "Waiting for the relay to answer",
      };
    case "revoked":
      return {
        label: host ? `Refused by ${host}` : "Refused by the relay",
        detail: "The relay no longer accepts this computer, so Daintree won't reconnect to it",
      };
    default:
      return {
        label: "Not connected",
        detail: host ? `Set up with ${host}` : "No relay is set up on this computer yet",
      };
  }
}

/**
 * Connection: the service state #16001 reports. The relay address, its
 * check, and claiming or restoring a relay join this section (#16005, #16006).
 */
export function DecisionsConnectionSection({ status }: { status: DecisionsStatus }) {
  const { label, detail } = describeConnection(status);
  return (
    <SettingsSection
      title="Connection"
      description="Questions and answers travel through a relay in your own Cloudflare account. Daintree runs no server for this."
      id="decisions-connection"
    >
      {/* The whole observation, label and detail, so a change is heard in full. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {detail ? `${label}. ${detail}` : label}
      </span>
      <SettingsGroup>
        <SettingsRow
          id="decisions-connection-status"
          label={label}
          accessory={
            status.state === "revoked" ? (
              <SeverityMark severity="warning" label="Refused" className="h-3.5 w-3.5" decorative />
            ) : undefined
          }
          description={detail}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
